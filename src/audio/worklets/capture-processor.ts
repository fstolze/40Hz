/**
 * AudioWorkletProcessor that keeps the last few seconds of what passed
 * through it, so the integrity checks can look at real output rather than at
 * what the graph was asked to produce.
 *
 * A terminal branch, like the existing analyser taps: it has an input and no
 * outputs, so it cannot colour what the listener hears. Nothing it does is
 * audible, and nothing it fails to do is either.
 *
 * Two things make this more than a ring buffer:
 *
 * **Epochs.** A configuration fingerprint says what the settings are *now*; it
 * says nothing about the seconds of older audio still sitting in the buffer.
 * Comparing a window recorded across a change against the configuration that
 * ended it would produce a confident, wrong answer. So the ring is emptied
 * whenever the configuration changes or a session starts, and a window is only
 * eligible once a whole one has accumulated since — never padded, never
 * partially filled.
 *
 * **Requests are answered when a window exists**, rather than the caller being
 * told "not yet" and having to poll — immediately if the ring already holds
 * enough audio from this epoch, and otherwise as soon as it does. Waiting for
 * the next quantum even when the window was already there would shift every
 * capture by one, and would lose a perfectly good window to a stop or an epoch
 * that arrived in the gap. Requests carry an id and are echoed back with it,
 * because several can be outstanding at once and a reply that cannot be
 * matched to its question is worse than none.
 */

export interface CaptureRequestMessage {
  type: 'capture';
  /** Echoed back on the reply. Several requests may be in flight at once. */
  id: number;
  /** How many frames the window should hold. */
  frames: number;
}

/** Empty the ring: the audio before this point belongs to something else. */
export interface CaptureEpochMessage {
  type: 'epoch';
}

export interface CaptureStopMessage {
  type: 'stop';
}

/**
 * Withdraw a request the caller has stopped waiting for.
 *
 * Without this a request the other side timed out stays queued here for the
 * rest of the session: it still counts against `maxPending`, so a run of
 * timeouts eventually refuses live requests, and it still allocates and
 * transfers a full window if the audio it was waiting for ever arrives.
 */
export interface CaptureCancelMessage {
  type: 'cancel';
  id: number;
}

export type CaptureMessage =
  CaptureRequestMessage | CaptureEpochMessage | CaptureStopMessage | CaptureCancelMessage;

/** Why a request was not answered with audio. */
export type CaptureRefusal =
  /** Longer than the ring itself, so no amount of waiting would fill it. */
  | 'window-too-long'
  /** Not a usable frame count at all. */
  | 'window-invalid'
  /** Too many already waiting; this one is dropped rather than queued forever. */
  | 'too-many-pending'
  /**
   * The configuration moved on while this was waiting.
   *
   * Answering it anyway would hand the caller audio from the new epoch under
   * the id it issued for the old one — which is precisely the confident wrong
   * answer epochs exist to prevent, since the caller matches replies to
   * fingerprints by id. The caller asks again when it wants the new one.
   */
  | 'epoch-changed'
  /** Playback ended while this was waiting; no more audio is coming. */
  | 'stopped';

export interface CaptureWindow {
  type: 'capture';
  id: number;
  ok: true;
  /** Channel data, transferred rather than copied. */
  left: Float32Array;
  right: Float32Array;
  frames: number;
  /**
   * Which epoch this window belongs to, counting from zero.
   *
   * A reply **can** cross an epoch, which is why this is carried. Refusing what
   * is still queued here covers only the requests this processor has not
   * answered yet: a window recorded and posted while the old configuration was
   * in force is already on its way out, and nothing at this end can recall it.
   * The stamp is how the receiver recognises one and throws it away.
   */
  epoch: number;
  /**
   * The frame index of the window's first sample, on the context's own clock,
   * and the same instant in seconds.
   *
   * Carried so the caller can decide whether the window overlapped something
   * that would make it meaningless — a ramp, a fade, a stop — rather than
   * assuming it sits inside steady playback.
   */
  startFrame: number;
  startedAt: number;
}

export interface CaptureRefused {
  type: 'capture';
  id: number;
  ok: false;
  reason: CaptureRefusal;
}

export type CaptureReply = CaptureWindow | CaptureRefused;

export interface CaptureProcessorOptions {
  processorOptions?: {
    /** Ring length. The longest window anything may ask for. */
    seconds?: number;
    /** How many requests may wait at once before further ones are refused. */
    maxPending?: number;
  };
}

/** Long enough for the slowest check, short enough to stay a rounding error in memory. */
const DEFAULT_SECONDS = 3;
const DEFAULT_MAX_PENDING = 8;

interface Pending {
  id: number;
  frames: number;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly capacity: number;
  private readonly maxPending: number;
  private readonly left: Float32Array;
  private readonly right: Float32Array;

  /**
   * Frames written since the epoch, not since construction.
   *
   * Doubles as the write cursor — `written % capacity` is where the next frame
   * goes — and as the eligibility test, since a window is ready exactly when
   * this reaches its length.
   */
  private written = 0;

  /**
   * The context frame the first sample after the epoch was written at, or -1
   * before anything has been.
   *
   * Taken in `process` rather than when the epoch message arrives: messages are
   * delivered between render quanta, so the clock at that moment is the start
   * of the quantum already rendered, which is not where the new audio begins.
   */
  private epochFrame = -1;

  private pending: Pending[] = [];

  /** Bumped on every reset, and stamped on every window handed out. */
  private epochId = 0;

  private running = true;

  constructor(options?: CaptureProcessorOptions) {
    super();

    const seconds = options?.processorOptions?.seconds ?? DEFAULT_SECONDS;
    this.capacity = Math.max(1, Math.ceil(seconds * sampleRate));
    this.maxPending = options?.processorOptions?.maxPending ?? DEFAULT_MAX_PENDING;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);

    this.port.onmessage = (event: MessageEvent<CaptureMessage>) => {
      const message = event.data;
      if (message.type === 'stop') {
        // Settled rather than abandoned: nothing more will be recorded, so a
        // request still waiting would never be answered at all, and one that
        // happens to be satisfiable must not be filled from across the stop
        // boundary — the fade is in that audio.
        this.running = false;
        this.settle('stopped');
        return;
      }
      if (message.type === 'epoch') {
        this.epoch();
        return;
      }
      if (message.type === 'cancel') {
        // No reply: the caller has already stopped listening for one.
        this.withdraw(message.id);
        return;
      }
      this.request(message);
    };
  }

  /**
   * Forget everything recorded so far.
   *
   * Cheaper than zeroing the arrays, and equivalent: nothing is readable until
   * `written` has climbed back past a window's length, so stale samples still
   * sitting in the buffer can never be handed out.
   */
  private epoch(): void {
    // Anything waiting was asked under the configuration that just ended.
    // Filling it from the new one would answer the old question with the new
    // audio, so it is refused and the caller re-asks — which also stops
    // repeated edits accumulating stale requests until `maxPending` starts
    // refusing live ones and several large windows land at once.
    this.settle('epoch-changed');
    this.epochId += 1;
    this.written = 0;
    this.epochFrame = -1;
  }

  /**
   * Drop one waiting request, shifting the rest down.
   *
   * In place, like `deliver`. `filter` would allocate a replacement array on
   * the audio thread every time a request was withdrawn, which is the same
   * garbage this processor avoids everywhere else — collection here perturbs
   * the signal the whole subsystem exists to measure.
   */
  private withdraw(id: number): void {
    // Indexed rather than `findIndex`: a callback is an allocation too, and
    // this runs on the audio thread.
    let at = -1;
    for (let i = 0; i < this.pending.length; i += 1) {
      if (this.pending[i].id === id) {
        at = i;
        break;
      }
    }
    if (at < 0) return;

    for (let i = at; i < this.pending.length - 1; i += 1) {
      this.pending[i] = this.pending[i + 1];
    }
    this.pending.length -= 1;
  }

  /** Refuse everything waiting, for a reason that applies to all of them. */
  private settle(reason: CaptureRefusal): void {
    for (const request of this.pending) this.refuse(request.id, reason);
    // Truncated rather than replaced: this runs on the audio thread.
    this.pending.length = 0;
  }

  private request(message: CaptureRequestMessage): void {
    if (!this.running) {
      this.refuse(message.id, 'stopped');
      return;
    }
    const frames = Math.floor(message.frames);
    if (!Number.isFinite(frames) || frames <= 0) {
      this.refuse(message.id, 'window-invalid');
      return;
    }
    if (frames > this.capacity) {
      // Refused now rather than queued: no amount of audio would satisfy it,
      // and a request that can never complete would sit here for the session.
      this.refuse(message.id, 'window-too-long');
      return;
    }
    // Already satisfiable: answer now. Deferring to the next `process` would
    // move the window a quantum later than the one asked for, and would let a
    // stop or an epoch arriving in that gap refuse a request whose audio was
    // sitting in the ring the whole time.
    if (frames <= this.written) {
      this.fulfil({ id: message.id, frames });
      return;
    }
    if (this.pending.length >= this.maxPending) {
      this.refuse(message.id, 'too-many-pending');
      return;
    }
    this.pending.push({ id: message.id, frames });
  }

  private refuse(id: number, reason: CaptureRefusal): void {
    const reply: CaptureRefused = { type: 'capture', id, ok: false, reason };
    this.port.postMessage(reply);
  }

  /**
   * Copy the most recent `frames` frames out, oldest first.
   *
   * The ring is read in at most two runs — the tail of the buffer and then its
   * head — so a window that spans the wrap comes back in the order it was
   * played rather than rotated.
   */
  private read(frames: number): { left: Float32Array; right: Float32Array } {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);

    const end = this.written % this.capacity;
    let start = end - frames;
    if (start < 0) start += this.capacity;

    const first = Math.min(frames, this.capacity - start);
    left.set(this.left.subarray(start, start + first), 0);
    right.set(this.right.subarray(start, start + first), 0);
    if (first < frames) {
      left.set(this.left.subarray(0, frames - first), first);
      right.set(this.right.subarray(0, frames - first), first);
    }

    return { left, right };
  }

  /**
   * Answer whatever is now answerable, and keep the rest.
   *
   * Compacted in place. Partitioning into two fresh arrays allocated on every
   * render quantum that had anything pending — around 750 a second at 48 kHz,
   * for as long as a window takes to fill — and garbage collection on the
   * audio thread is a way to change the very signal this exists to measure.
   * Nothing is allocated here unless a request actually completes.
   */
  private deliver(): void {
    if (this.pending.length === 0) return;

    let keep = 0;
    for (let i = 0; i < this.pending.length; i += 1) {
      const request = this.pending[i];
      if (request.frames > this.written) {
        this.pending[keep] = request;
        keep += 1;
        continue;
      }
      this.fulfil(request);
    }
    this.pending.length = keep;
  }

  private fulfil(request: Pending): void {
    const { left, right } = this.read(request.frames);
    const startFrame = this.epochFrame + (this.written - request.frames);
    const reply: CaptureWindow = {
      type: 'capture',
      id: request.id,
      ok: true,
      left,
      right,
      frames: request.frames,
      epoch: this.epochId,
      startFrame,
      startedAt: startFrame / sampleRate,
    };
    // Transferred, not copied: these are the only references, and the audio
    // thread has no business allocating a second copy of every window.
    this.port.postMessage(reply, [left.buffer, right.buffer]);
  }

  process(inputs: Float32Array[][]): boolean {
    // Stopped: record nothing further. The quantum after a stop contains the
    // end of the fade, and everything waiting was already settled.
    if (!this.running) return false;

    const input = inputs[0];
    // Nothing connected yet, or a silent upstream node Chromium has stopped
    // filling. Either way there is nothing to record and nothing to answer.
    if (!input || input.length === 0 || !input[0]) return this.running;

    const left = input[0];
    // A mono upstream is written to both sides rather than left half-silent,
    // so a window is always a stereo pair and the analysis needs no special
    // case. The taps this hangs off are stereo; this is for the odd graph.
    const right = input[1] ?? input[0];
    const frames = left.length;

    if (this.epochFrame < 0) this.epochFrame = currentFrame;

    let position = this.written % this.capacity;
    for (let i = 0; i < frames; i += 1) {
      this.left[position] = left[i];
      this.right[position] = right[i];
      position += 1;
      if (position === this.capacity) position = 0;
    }
    this.written += frames;

    this.deliver();
    return this.running;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
