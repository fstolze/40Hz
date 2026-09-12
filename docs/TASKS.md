# Tasks

Working list of shipped work, unresolved items, decisions, and loose ends. The completed
implementation plan is preserved in Git history; this file remains the current tracker.

Check items off as they land. `git log --follow -- docs/TASKS.md` is the progress history.

---

## Step 1 — Engine + offline test harness ✅

Done. DSP core, both generation paths, procedural noise, FFT/Hilbert analysis, worklet shells,
Web Audio graph. See [README.md](../README.md).

## Step 2 — Studio ✅

Done. Electron + Vite + Svelte 5 shell, mixer UI, live envelope scope and spectrum, six built-in
presets plus user save/load, standalone-in-browser renderer.

---

## Step 3 — Session + tray ✅

Done. Tray icon and popover on their own Vite entry, session coordinator in main, history and
settings on disk, the daily advisory, and a global hotkey that stops rather than starts.

The compact surface: pick a preset, pick a duration, start. No knobs. A reduced view over the
same state store as Studio, not a second implementation.

Core first, as in steps 1–2: `src/session/` holds the model, phase machine, and history as pure
clock-injected functions with no Electron or Web Audio imports, so the timing is verified offline
before any of it is wired to a window.

- [x] Session model — record shape, phases, completion reasons, integrity status
- [x] Phase machine — elapsed, remaining, progress, ramp and stabilization boundaries
- [x] History — listening time per day, recent recall, deletion, advisory and cooldown
- [x] Fade scheduled so silence lands at the planned end, not starts there
- [x] Listening time split at local midnight rather than attributed to the start day
- [x] Portable configuration module, so the coordinator needs no import from `graph.ts`
- [x] Playback envelope on its own gain node, scheduled on the AudioContext timeline, so a
      control change can no longer cancel a session fade
- [x] Tray icon and popover window, on its own Vite entry so it carries no audio engine
- [x] Preset picker (built-ins + saved) — Studio's, bound to the session's source
- [x] Duration picker and countdown timer
- [x] Ramp-in on start, ramp-out on completion
- [x] Stabilization indicator marking the ~5–6 minute threshold
- [x] Global hotkey — stops what is playing; opens the popover when idle rather than starting
      blind, per reminders-never-autoplay
- [x] Recent-session recall — the last few presets actually run, offered in the popover
- [x] Persist history to disk, and surface the day's listening time
- [x] Launch at login (renamed from "auto-start", which read as autoplay) — macOS and Windows;
      absent on Linux, where autostart is a packaging concern rather than a runtime one
- [x] Main-owned store on disk — serialized, atomic, versioned, normalizing, deduplicating
- [x] Executor link — registration, correlation ids, timeouts, replacement
- [x] Session publication — atomic snapshot-and-revision subscription
- [x] Session coordinator — arbiter state machine, start transaction, dual clocks, checkpoint
      and recovery; wired in main over the store and the executor link
- [x] Session panel, Preview/Session arbitration, and edit reporting in Studio
- [x] Electron smoke test over the real preload, IPC and persistence path
- [x] Move presets off `localStorage` to disk via IPC, with a one-time legacy import
- [x] Daily listening advisory at a configurable threshold (listener safety; advisory only)
- [x] Settings store on disk, and a settings surface in Studio
- [x] History surface with per-record and whole-log deletion

## Step 4 — Signal integrity

**No longer a product differentiator.** Recorded as one; **this stack** does not support it. What
this is now: a bounded runtime QA subsystem and an optional Windows extension. The one actionable
safeguard it was meant to carry did not survive contact with real devices — see the validation
notes — so what remains for the listener is unconditional guidance beside the routing control.
It should not block higher-value user-facing work.

**Descoped against the installed Electron before starting** — see the decision below. What is left
is what Electron 43 and Web Audio can actually answer, which is
narrower than what the operating systems can: the descoped list below now says which is which,
because "no API exists" and "no API Electron exposes" imply completely different fixes. Every finding
carries a scope: `engine` (offline DSP), `graph` (our own output, pre-`destination`), `systemMix`
(what the OS mixed — Windows loopback only, and contaminated by other applications), and `delivery`
(DAC, transducer, air — **no checker on any platform**). A scope is `unknown` where it cannot be
measured, never `ok`.

### 4A — runtime verification and honest recording

The model (pure, `src/integrity/`, no Electron and no Web Audio, matching `src/session/`):

- [x] `Finding` over the existing four-value status enum, as a readonly union whose unchecked
      branch has the literal status `'unknown'` — so a finding claiming to have passed without
      running has no inhabitant, rather than merely no constructor
- [x] `delivery` is not a `CheckableScope`, so a finding claiming to have checked it does not
      typecheck — the prose said it had no checker while the type allowed one
- [x] `overallStatus` counts scopes nothing reported on, so a partial report cannot read `ok` by
      omission — the failure a producer forgetting a placeholder would otherwise cause silently.
      It therefore never returns `ok` at all, which is why the surface is a coverage summary.
- [x] `overallStatus` (`failed` > `warning` > `unknown` > `ok`) and `recordedStatus` +
      `checkedScopes` — two questions, two answers. The ordering stays; only the surface changes.
- [x] `mergeFindings` — per finding id and checked-aware, so a placeholder cannot pin the aggregate
      for a whole session and a warning survives a later clean pass
- [x] Rules module: observations to findings, each rule owning its threshold and its copy. One
      rule, which is the finding of the step rather than an omission — the copy is asserted in
      `test/devices.test.ts`, because the wording is what keeps three readings facts.

Measurement:

- [x] Engine self-test as `engine`-scoped findings: envelope rate for all three shapes, AM spectrum
      symmetry and the absence of second-order sidebands, both two-tone routings, block
      independence, and phase drift. Invariants rather than remembered numbers, so it cannot come
      to certify whatever the engine currently does; 56 ms for the suite; every check proved to
      fail against a renderer broken in exactly the way it exists to catch.
- [x] Surface it, so the _shipped build_ is what gets proved on the user's machine rather than only
      CI's checkout. Runs once at startup, off the first paint, into the renderer's current view.
- [x] Capture worklet: stereo ring buffer, no outputs, epoched on configuration change and at
      session start so a snapshot cannot contain pre-change audio. Requests are deferred rather
      than refused until a whole window has accumulated, carry an id so overlapping ones can be
      told apart, and transfer their buffers rather than copying on the audio thread. Third entry
      in `ENTRIES`.
- [x] Wire the two taps in `graph.ts`, send the epoch on configuration change and session start,
      and track the steady-playback window so a capture cannot span a ramp. Correlating reports
      with the executor generation and session id belongs to A5, where the reports are sent.
- [x] Envelope depth and frequency, interaural correlation, and `fc ± modulationHz` sidebands at
      the entrainment tap, against `renderOffline` of the same parameters on scale-invariant metrics
      — asserted to survive a quarter-level capture and a window starting mid-cycle, and to notice
      a flattened envelope, a collapsed stereo pair, and missing sidebands
- [x] Peak level, non-silence, and clipping headroom at the master tap — bounds only, no oracle,
      since `renderOffline` models the synthesis core and not the bed, envelope, or compressor.
      The ceiling is a parameter rather than an import, so the module stays free of `graph.ts`.
- [x] Fix `Scope.svelte`'s modulation-index readout at source: float samples rather than the
      byte-quantized view, and a rectified envelope binned at a whole carrier cycle rather than at
      the drawing resolution. Verified on the Focus preset at −11.1 dB and −21.4 dB, where it read
      775% before and reads 100.0% now.

Reachable device observations — **facts, not verdicts, all four of them**. The stereo check was the
one candidate for a rule and did not survive contact with real devices:

- [x] Graph render rate vs the 48 kHz requested — an observation; it is not the hardware rate
- [x] `baseLatency` / `outputLatency` — reported as measured, not read as transport. An absent
      `outputLatency` reads as absent, never as zero.
- [x] Default `audiooutput` device from `enumerateDevices()`, refreshed on `devicechange`; label
      only when already available, absent label recorded as `unknown` rather than omitted. A
      directory that throws is distinguished from one with no outputs.
- [x] **`maxChannelCount < 2` while `twoToneMode === 'dichotic'`** — built as the one finding a user
      can act on, then **withdrawn**: it never fired on any device on any platform, including with
      Windows' Mono audio setting on. It is a device fact now, and the guidance it used to carry is
      unconditional beside the routing control. See the validation notes below.
- [x] The start path the control does not cover: the popover shows what binaural routing needs
      whenever the preset it would start is dichotic. Guidance, not the device finding — only
      Studio holds an AudioContext, so only Studio can ask how many channels the output accepts,
      and a standing channel through main for a fact this window shows once per start is machinery
      for an edge case.

Reporting and recording:

- [x] `coordinator.reportIntegrity()` through the existing `Serial` queue, owning the aggregate
      outright as the worst valid observation of the session; the unimplemented main-owned
      `integrityStatus` dependency is removed rather than filled in. Reset at session start and
      nowhere else — a second reset in `finish()` was removed because no test could drive it into
      failure while the first one stood. Refused once the record has been appended, and bounded at
      `MAX_SESSION_FINDINGS` distinct ids: a message-sized limit bounds nothing when a hundred
      lawful messages each bring fresh ids.
- [x] Persist `integrityStatus` and `integrityCoverage`, `HISTORY_VERSION` to 2, coverage
      deep-copied in `snapshotRecord` — so an older build refuses the file rather than erasing it.
      Normalized on read as well: allowlisted scopes only, deduplicated, canonically ordered, and
      `[]` for a v1 file.
- [x] Finalization ordering test: a queued report is either included in the record or cleanly
      rejected after finalization — driven from inside the executor's `stop`, which is the only
      moment that actually races. (Checkpoint-race and recovery tests are 4B.)
- [x] IPC surface, and the "exposes exactly the surface" test extended to the `executor` group it
      omitted entirely. The report **waits for its answer**, unlike `reportConfiguration`: an edit
      is superseded by the next edit, but a measurement is not, so a producer has to be able to
      tell a recorded report from a refused one — carried all the way out to `SessionClient`, so
      A4 and A6's producers get the answer rather than the send. Proved end to end against a real
      record on disk, including a report claiming to have checked `delivery`, which the boundary
      refuses.

Surface:

- [x] A quiet **coverage summary** in the Studio footer, not a traffic light: "Currently checked:
      engine and app output — clear · not checked: system mix and delivery". Escalates in
      appearance only when a _checked_ finding is `warning` or `failed`. On macOS and Linux
      `overallStatus` can never reach `ok`, since `delivery` is never checked anywhere, so a status
      light has an unreachable colour.
- [x] Detail in the existing Studio dialog, grouped by scope, each unchecked scope saying why, with
      the device facts below it.
- [x] **One renderer-owned current view**, which the footer, the panel and the session reporter all
      read. Producers write to it; nothing rebuilds findings separately for display and for
      reporting. It answers "what do the checks say now?" while the coordinator's aggregate answers
      "what was the worst checked result during this session?" — the disagreement is intentional
      history, so there is no read-back channel, and the panel says so in as many words. A refused
      report never edits a finding: delivery is not truth.
- [x] Drive the capture measurements during playback, so `graph` coverage means the audio was
      measured rather than the channel count read. Event-driven, never periodic: a pass when
      playback settles and after each configuration change, coalesced onto a trailing pass so a
      slider drag costs one measurement — of the position the user stopped on. Plus **Check app
      output now** in the panel, named for what these taps can reach, which end before
      `AudioContext.destination`.
- [x] Two things the real graph taught that no fixture had: a tap answers with the _most recent_
      window, so a pass must wait a whole window past the ramp rather than starting when steadiness
      opens; and the timer runs on the wall clock while the boundary is on the audio clock, which
      drift apart while a context is suspended — measured at 98 ms — so a pass re-checks on waking
      and reschedules rather than measuring early.

### Verified on Windows and Linux

Both suites green on each platform after two repairs (a compositor-sensitive popover resize test,
and npm 11's install-script approval). What the by-hand checks found, which no suite can reach:

- **`outputLatency` is real everywhere** — 72 ms on Linux, ~50 ms on Windows, 56 ms on macOS, and
  zero on all three until audio has been rendering for a moment. The second look after playback
  starts is what makes the fact appear at all.
- **`maxChannelCount` never reported anything but 2**, so the one rule in this step was demoted to
  a fact. It read 2 for a physically mono Jabra speakerphone, a deliberately one-channel PipeWire
  sink, Galaxy Buds in their mono hands-free profile, and finally with **Windows' Mono audio
  setting switched on** — which combines left and right into one and so destroys a binaural beat
  outright. Windows 11 no longer offers a separate hands-free endpoint to select; it swaps the
  profile behind one device entry, so the Meet call was the real thing.

  Three consequences, and the last one is the important one:

  - The reading describes what our graph may emit, not what the listener gets. It is now the
    fourth device fact, worded to say so.
  - `graph` is **uncovered** again until something drives the capture measurements. A session used
    to record it on the strength of a number read rather than audio measured, which was an
    overclaim in the record as well as on screen — so `HISTORY_VERSION` goes to 3, a v2 file has
    that coverage stripped on read, and `dev:web`'s `localStorage` history moves to a key naming
    the same version, correcting what was under the old one on the way across. The status is left alone: those checks did run, and the engine
    self-test was among them. Only the coverage claim was wrong, and leaving it would make old
    records indistinguishable from the ones real measurements will produce.
  - **Channels combined below the app are undetectable from Web Audio.** The guidance beside the
    routing control is now unconditional, because nothing can tell when it is needed — and 4C's
    Windows loopback is the only mechanism in this plan that could ever catch it, which raises it
    from an optional platform extension to the only checker for the failure mode that matters most.

- **`devicechange` does not cover a default-sink switch on Linux.** Changing the PipeWire default
  while playing fired no event, so the panel kept naming the old device; Windows fired it and
  updated within seconds. Playback starting now re-reads the directory as well, which closes the
  gap at the only moment the user has just acted. A physical unplug on Linux — which does change
  the device set — was not tested.

### 4B — crash durability, deferred

Separates ordinary correctness from protection against the rarer warning-plus-crash combination.

- [ ] Aggregate into the active checkpoint, so recovery cannot write `unknown` over an observed
      warning
- [ ] An update path for a report that arrives after the record is written. A5 refuses those —
      `appendHistory` is idempotent by id, so accepting one would answer "recorded" for something
      that can never reach the file — but the window is real: a failed `clearCheckpoint` leaves
      the session owned with its record already durable. Refusing is honest, not complete.
- [ ] Dirty flag on a failed checkpoint write, retried on the heartbeat
- [ ] Checkpoint race tests: no checkpoint resurrection after `clearCheckpoint()`; a failed write
      retries even when the following aggregate is identical; recovery preserves the warning

### 4C — Windows loopback, separate

**Raised in standing by the validation runs.** It is the only mechanism _in this stack_ that could
ever notice the system combining the channels below the app — the failure that kills a binaural
beat outright, that a common accessibility setting causes, and that nothing in Web Audio can see.

Worth deciding with the next entry in mind rather than on its own: a native device query would
answer more, on all three platforms, and answer it before playback rather than by analysing a
capture. If a native module is ever on the table, do that comparison first.

- [ ] `setDisplayMediaRequestHandler` with `audio: 'loopback'`, analysed by the same code
- [ ] Populate `systemMix` coverage only where it actually ran — never `delivery`, and inferring
      nothing on macOS or Linux
- [ ] Document it as a **Windows-only capability, not an operating-system tier**

### Dropped

- **Popover presentation of the integrity report.** Presentation-only work over a report main
  already holds. Not built unless use demonstrates a need.

### Descoped from step 4, with reasons

Recorded rather than deleted: these are real downstream failure modes that **this stack** cannot
observe. The app does not detect them and does not guess at them.

**Read "this stack", not "this platform".** An earlier version of this list said "no API exists"
for most of these, and that was wrong in a way worth correcting: the APIs exist, and Electron does
not expose them. The distinction decides what a fix would look like — more Web Audio will never
get there, a native device query would — and stating it as a platform fact is how a wrong
conclusion hardens. What each one would take:

- **Bluetooth transport and codec.** No Electron or Chromium API. Latency is not a proxy — a
  threshold fitted on one machine is a guess, and this project has made that mistake twice.
  _Natively:_ macOS answers directly through `kAudioDevicePropertyTransportType`, and PipeWire
  reports `api.bluez5.profile`, which separates `a2dp_sink` from `headset_head_unit` — the
  hands-free case the withdrawn stereo rule was written for. Windows exposes the endpoint's bus
  and form factor.
- **Windows Sonic / Dolby Atmos / macOS Spatial Audio.** No Electron API, and `maxChannelCount` is
  our own graph's capability rather than evidence of a spatialiser. _Natively:_ Windows exposes a
  spatial-audio state per endpoint; the macOS side is less clear and would need checking before
  anything is promised.
- **Windows per-device Audio Enhancements.** No Electron API; applied below the application layer.
  _Natively:_ partially inspectable through the endpoint's effect properties — and moot under
  exclusive mode, which bypasses them.
- **Exclusive-mode availability.** Not reachable without a native module; deferred as a whole
  already, under Decisions below. Worth noting what it would buy, which is not detection but
  **prevention**: WASAPI exclusive and CoreAudio hog mode bypass the system mixer, so the mono
  downmix, the enhancements and the resampling stop being possible rather than merely visible.
- **macOS loopback via ScreenCaptureKit**, and **Linux loopback via PulseAudio/PipeWire.**
  `audio: 'loopback'` is documented Windows-only in Electron 43, so neither is reachable here.
  _Natively:_ both exist — ScreenCaptureKit on macOS 13+, Core Audio process taps on 14.2+, and
  monitor sources on Linux. This entry previously read "neither exists", which was a claim about
  Electron written down as a claim about the operating systems.
- **Delivery — the converter, the transducer, the air.** Unchanged by any of this. No language and
  no API reaches it; measuring it means measuring sound in the room.

### If a native audio layer is ever considered

Not a proposal, and not scheduled. Recorded because the validation runs made the trade legible, and
because the next person to ask "why can't it just tell me whether my headphones are mono?" deserves
the real answer rather than the Electron-shaped one.

- **What it would fix.** The endpoint's true channel count (CoreAudio stream configuration, WASAPI
  `GetMixFormat`), the transport (Bluetooth, and on Linux the A2DP-versus-hands-free profile),
  system-mix capture on **all three** platforms rather than Windows alone, and — through exclusive
  or hog mode — the ability to **prevent** the system mixer's downmix and effects rather than
  detect them.
- **What it would not fix.** `delivery`. That one is physics.
- **What it would cost.** Three platform backends where there is now one; the loss of `dev:web`,
  which is how most UI work here is actually verified; the loss of "`npm test` needs no install";
  and a genuine rewrite of everything below `SessionPanel`. Tauri keeps the Svelte UI and moves
  audio into a Rust core, which is the only version of this worth costing.
- **The cheap middle.** A small native helper — napi-rs addon or sidecar — answering two questions
  only: the endpoint's real channel count and its transport type. Feed those into the existing
  observation pipeline and the withdrawn stereo rule comes back, with a real Bluetooth fact beside
  it. Perhaps a few hundred lines, against a rewrite; it costs the no-install property for that one
  module and complicates signing.
- **The judgement, for now.** No. The DSP, the session model and the safety posture are the value
  here and all three are done and verified. But if the actionable finding is ever wanted for real,
  the answer is a native device query — not more Web Audio.

### Later, separate items

- [ ] Token-scoped stop in the arbiter, and the idle integrity check that depends on it. An
      unconditional `stop()` in a `finally` would stop a session the popover started while the
      measurement was running.

## Step 5 — Polish

- [ ] User-supplied audio files as the bed
- [x] Manual carrier selection with a tuner display — the authoritative control, built first
- [ ] Offline key detection at import, returning several candidates with confidence
- [ ] Suggestion UI that proposes a carrier and waits for confirmation, never applying on its own
- [ ] Call-aware ducking. **Needs an OS capability Electron does not expose** — the same wall step 4
      hit. Chromium reports media _permission_ state and capture sources, not whether another
      application is on a call. Not descoped on principle; descoped on the same evidence.

### Gate A — the notch headroom bound: **passed, static model and real node**

Recorded because the number was not knowable before the sweep, and because the correction it
produced applies to the **procedural bed in the shipped build**, not only to imported files.

`worstCaseSourcePeak` counted the bed as `soundscape.gain` alone, on the grounds that the notches
only cut. That is true of the magnitude response and false of peak amplitude: a cut biquad rings.
The old headroom test could not have caught it — it summed raw noise with no notch chain at all.
Reachable through the Studio sliders alone (white bed at 0.8, depth 18, Q 1, fc 440, level 0.6), the
output peaked at 1.109 against a documented ceiling of 0.8 — above full scale, so it clipped and
forced the limiter, which `graph.ts` says should never engage.

**What the bound is.** The L1 norm of the notch cascade's impulse response, computed for the
current configuration. As one global constant it would have been the worst chain in the space,
3.54x, costing 11 dB everywhere and failing the gate. Per configuration:

| preset   | cost    |
| -------- | ------- |
| focus    | 0 dB    |
| smooth   | 0 dB    |
| binaural | 0 dB    |
| monaural | 0 dB    |
| masked   | 2.63 dB |
| contrast | 2.62 dB |

Noise and file beds share the path and the bound, so a file bed reaches exactly the level pink
noise reaches. No fallback from the ladder was needed.

**What the bound is not.** It is **empirical with a measured margin**, not a certified upper bound,
and the difference is recorded rather than glossed. The truncation remainder is _estimated_
geometrically from the largest pole magnitude, which is not a proof — cascaded modes can beat, and
repeated or near-repeated poles introduce polynomial factors a geometric envelope does not cover.
A grid sweep also says nothing between its points. So `BOUND_MARGIN` is applied unconditionally,
sized by measurement: extending the analysis window eightfold across the whole admitted space
changes the sum by at most 9.0e-8 relative, and 1% exceeds that by about 1e5 while costing under
0.09 dB.

**The cascade is the model now, so there is nothing to reconcile.** `dsp/biquad.ts` was a
description of Chromium's `BiquadFilterNode`, and the bound computed from it needed an Electron
test to establish the two agreed. The notch cascade now runs in a worklet that takes its
coefficients from that same file, so the bound is computed from the implementation. The Electron
suite still sweeps the shipped worklet — its static cascades against `notchPeakGain`, and live
handovers against `transitionPeakBound` — but it asserts the implementation against its own bound
rather than reconciling two of them.

The move was forced by listening, not by the bound. Getting a zero-state cascade from
`BiquadFilterNode` meant building nodes mid-playback, and changing the graph's topology under a
running renderer is audible on its own — rebuilding with _identical_ coefficients clicked just as
loudly, which is what named it after three rounds of looking at the filters. Inside a worklet a
fresh state is a field assignment and the node count never changes.

**Transitions are ordered.** Notch coefficients and source gains used to move at once while the
master ramped to its new headroom over 50 ms, so a change that raised the bound left the old, higher
gain in force for the whole ramp. `commitConfiguration` now takes one guarded path for every change
rather than branching on direction — the earlier two-branch version applied the less-attenuation
case immediately, which is exactly when the master rises, and so raised it while the old, louder
source gains were still decaying.

**The two mechanisms land on the same frame, and the whole path is bounded.** An AudioParam is
sample-accurate; an AudioWorklet can only act on a render-quantum boundary; and the worklet's
`amGain` and `twoToneGain` then approach their targets through a one-pole smoother. Three
mechanisms, none simultaneous with the others. The landing is quantised so the first two arrive
together, but the third cannot be scheduled at all — so the master is held at a level safe for
`transitionPeakBound`, the worst case over _every_ state between the two configurations, rather
than for either endpoint.

That is not a refinement. A change lowering `amGain` while the master rose toward what the new
configuration permits multiplied a still-loud source by an already-raised gain: a source bound
falling 2 → 1 against a master rising 0.4 → 0.8 reaches **0.95 at 50 ms**, with both endpoints at
exactly 0.8. The branch that applied such changes immediately was removed rather than patched,
since it was precisely the case where the master rises.

### Gate A: the live-transition half, and how it was closed

Measured on the real `BiquadFilterNode`, not modelled. The bed term treats a transition as the
maximum of the two **static** L1 bounds, and that is not a bound while coefficients change: the
filter carries state fitted to the old coefficients into the new ones, and a resonant denominator
turns that mismatch into a large decaying transient.

| swept on the real node   | transitions | exceed the bound | worst ratio |
| ------------------------ | ----------- | ---------------- | ----------- |
| full admitted space      | 4698        | 912 (19%)        | **265x**    |
| UI-reachable values only | 4296        | 107 (2.5%)       | **11.6x**   |

The UI-reachable worst case is a carrier jump 1000 → 80 Hz with the notch controls moved: peak
29.7 against a bound of 2.56. Two presses of the tuner's octave-down button reach it.

This was recorded as passing on the strength of one hand-built shallow-to-deep transition whose
thresholds came from the same measurement it was checking, which established the _ordering_ and
nothing about the bound. The listening pass does not close it either — the development readout
displays `activeSourceBound()` and the master derived from it, so their product reaching the ceiling
is true by construction and measures nothing about the real post-filter output.

**Closed in two steps.** The first was rung 1 of the plan's ladder: never retune a cascade that is
carrying signal, build a fresh one with zero state and crossfade to it with gains that never sum
above one. Each cascade's own static bound then holds for its whole life, and

    |sum(g_i y_i)| <= sum(g_i L1_i) <= max(L1_i) sum(g_i) <= max(L1_i)

which is exactly the bed term `transitionPeakBound` already computed — the fix made the existing
bound true rather than needing a new one.

The second step was forced by listening rather than by the bound. Getting a zero-state cascade from
`BiquadFilterNode` meant building nodes mid-playback, and changing the graph's topology under a
running renderer is audible on its own: rebuilding with _identical_ coefficients clicked just as
loudly, which is what named it after three rounds of looking at the filters. The cascade now lives
in a worklet, where fresh state is a field assignment, the node count never changes, and the
crossfade is two sets of filter state inside one processor.

Handovers are not started while one is running, and are never cut short to begin another — an early
finish snaps the output to a cascade it is only part-way toward. A change that arrives mid-handover
is applied when that handover settles, which is the only thing that retries it: entrainment
settlement has been and gone by then.

The swept real-node gate is permanent, and now drives the shipped worklet at 22.05, 32, 48 and
96 kHz — sample rate enters the coefficients directly and sets the response length, so agreement at
one rate is not agreement.

**Verified by ear, and that mattered.** A listening pass over Masked, Maximum contrast and a
white-bed/full-entrainment mix confirmed the ceiling case audibly — the same settings clip and
drive the limiter on the pre-fix build and are clean after it — and the live readout agreed with
the model to four decimals (bound 2.906, master 0.2753, product exactly the 0.8 ceiling).

It found three defects nothing else had, over several passes.

`setColor` rebuilds the noise generators from fixed seeds, and the single commit path sends the
colour on every change, so dragging an entrainment slider restarted the bed about thirty times a
second. Correct sample by sample, and plainly wrong to listen to.

A chain rebuilt per change hands over faster than a fresh filter can carve its notch, so the slot
was never established while a control was moving. Rebuilds now happen only on settlement.

And the click that outlasted both was not the filters at all. Isolation switches settled it in two
listens where three rounds of reasoning had not: freezing the headroom guard left the click,
freezing the bed rebuild removed it, and rebuilding with _identical_ coefficients clicked just as
loudly. It was the graph's topology changing under a running renderer, which is why the cascade now
lives in a worklet.

The guard's own timing was verified separately, because Focus never engages it — its source bound
is 0.958 across the whole carrier range, so the master never moves there and no amount of listening
to that preset could have told us anything. On Masked, where it does engage, the fifty-millisecond
guard and the slower restore are clean; at eight milliseconds the step was the kind that clicks.

**Nothing is treated as audible until the worklet says so.** Scheduled time was standing in for
proof of application, while the same paragraph admitted that message delivery is unbounded — so a
change still in flight could be counted as sounding, and the next change would compute its guard
from it and relax the attenuation covering the difference. The worklet now returns the revision it
adopted, and only that promotes a configuration to audible or permits the master to leave the
transition level. Hearing nothing back leaves the attenuation in place, which is the right way for
this to fail.

Adoption and settlement are reported separately, because they are not the same claim. Adoption says
the frequencies and routing changed; the gains are still between the old and new values for another
210 ms. The worklet therefore **snaps** those gains to their targets before reporting settlement,
rather than approaching asymptotically — `BOUND_MARGIN` covers the notch chain's bed term and
nothing else, so a residual on `amGain` is covered by nothing, and a final bound of exactly 1 plus
any residual exceeds 1. The steady boundary is pushed again from when that settlement actually
arrives, not from the landing predicted at commit time.

The bound covers everything the smoother may still be carrying, not just the latest request: a
configuration adopted and superseded before it settled is still in the output, and `0 → 0.6 → 0`
would otherwise read as zero at both ends. A settlement is accepted only for exactly the pending
revision; anything else fails closed.

And the guard cannot be bypassed: `effectiveMasterLevel` is defined from the transition bound, so
`setMasterLevel`, `start` and `startSession` all inherit it rather than each having to remember.

## Packaging and distribution

- [x] electron-builder config — dmg, NSIS, AppImage, deb
- [x] App icon, generated alongside the tray icon from one script
- [x] Packaged smoke test — launches the shipped binary and proves the worklets still load
- [x] Builds stay manual and per-platform, by decision. CI runs the gates and never packages or
      publishes, so a distributable only exists because someone asked for one.
- [ ] Code signing and notarization. Deliberately deferred: an Apple Developer membership and a
      Windows certificate are the cost, and adding it later touches `electron-builder.yml` and the
      release workflow and nothing else. Until then recipients click through Gatekeeper and
      SmartScreen, which the README documents.
- [ ] Auto-update. Not started, and not worth it before signing — an unsigned update channel is
      worse than no update channel.
- [x] Decide whether `npm run dev` should have its own profile. **It already has one, on all three
      platforms**, and the note that said otherwise was wrong: `app.getName()` is `Electron` when
      unpackaged, so development writes to `…/Electron/`, never to the installed app's `fortyhz`
      profile. Measured on Windows and Linux during validation and confirmed on macOS afterwards.
      Nothing to change; what remains is only that presets and history made in development are
      invisible to the installed build, which is the behaviour you would want anyway.

---

## Reminders

Listed as optional to step 3 and not needed to complete it, but not speculative either: both follow
from the governing decision that this app **reminds and never autoplays**. Step 3 built the half
that reacts to listening already done — the daily advisory. This is the half that arrives before
anything has happened, which is the harder half to get right, since a notification that starts
audio is exactly what the decision rules out.

- [ ] Scheduled notifications — "Start focus session?" — that never begin playback themselves
- [ ] Optional `scheduledFor` on the session record, so reminders can arrive later without
      redesigning Session

---

## Later / speculative

- [ ] EEG integration (Muse, OpenBCI) to measure the auditory steady-state response directly

---

## Safety and claims

The health-claims and listener-safety requirements gate any user-facing release, not any particular
step.

**That gate is live.** Builds are shared with people now — unsigned, by hand, but shared — so these
are outstanding work rather than a future consideration. A gate that only applies to some later,
more official release is not a gate.

- [x] Volume ceiling with enforced ramp-in, never starting at level
- [ ] Full copy audit: keep all neurodegeneration material out of user-facing text, marketing,
      and store listings. Position as a focus and concentration tool. The footer disclaimer is
      in place; the rest of the strings have not been reviewed.
- [ ] Advisory for users with a history of audiogenic seizure, or with tinnitus or hyperacusis
- [ ] Explicit harshness warning on square-wave / low-`edge` settings. Currently only a tooltip
      on the Square shape button.

---

## Decisions

Four questions from the original plan, plus one that was lost and has been recovered. Recorded here
so the reasoning sits next to the work it constrains.

### Settled since

**Which platforms, and in what order?** → **All three; Linux best-effort.**

Never recorded until now: `product-brief.md` carried "Confirm Windows-first development" as an
open question and it went out with the file when that was removed as superseded.

macOS and Windows position the popover from `Tray.getBounds()`. Linux has no `getBounds()`, so it
falls back to a corner of the work area, and the README notes that tray presence there depends on
the desktop environment — GNOME needs a StatusNotifierItem extension. The fallback is small enough
that it is not worth a support decision that would be awkward to reverse.

This originally treated Linux as the weak leg of step 4. **That risk model is gone.** Step 4's
descoping put macOS and Linux in the same position — neither has OS loopback, and
Windows is the exception rather than Linux — so best-effort on Linux now rests on the tray alone,
which is where it always actually rested.

Windows also hides a new tray icon in the overflow chevron by default, so a first run can look as
though the app has no tray presence at all. That is onboarding copy, not a bug.

**Amended after testing on Ubuntu.** `new Tray()` succeeds and displays nothing where the desktop
has no StatusNotifierItem host, and Electron offers no way to ask. So nothing about the app's
lifecycle depends on the tray: closing Studio hides it on macOS and Windows, and quits on Linux,
finalizing any running session first. Best-effort now means the tray is a convenience where it
works rather than a load-bearing part of the app.

**Amended again, with a setting.** Hiding on close is now the default rather than the only
behaviour: `closeToTray` turns it off, and closing quits. It is offered on macOS and Windows only —
on Linux closing already always quits, so a control there would decide nothing, the same reason
launch at login is absent rather than present and ineffective.

**Should CI build distributables?** → **No. Builds are manual, per platform.**

CI runs the gates. It does not package and it does not publish, so a distributable exists only
because someone asked for one — no artifact appears from a push or a tag. Electron cannot
cross-build a macOS app anyway, and there are machines for all three platforms here, so a matrix
would spend CI minutes to produce what a local `npm run dist` produces already.

This is what makes signing a later decision rather than a blocking one: there is no unsigned
release channel quietly handing builds to anyone.

**Which presets are offered, and what may they say?** → **Six, described as signals, not
outcomes.**

Balanced pulse (the default), Gentle AM, Subtle pulse, Monaural beat, Binaural beat — headphones,
and a 500 Hz AM reference. Ids did not change, so existing records resolve to the new names.

The copy no longer ranks entrainment strength or implies focus. What the literature supports is
that audible 40 Hz modulation evokes a 40 Hz auditory steady-state response; behavioural results
are mixed, and none used these recipes. The only relative claims left are the two that were
measured directly: a binaural beat evokes a smaller response than an acoustic one, and the
response shrinks as the carrier rises — which is why the 500 Hz reference says it is not a
stronger setting. This covers the preset and soundscape strings only; the copy audit under Safety
and claims stays open for the rest.

Maximum contrast left the picker as a comfort decision rather than a research conclusion: square
gating is transient-rich, and the one positive behavioural study among those reviewed, an
audiovisual one, gated on and off. It stays in `LEGACY_PRESETS` so its records keep a name, and
square gating stays a Studio setting. Subtle pulse stays offered, and remains the one offered
preset that engages the headroom guard, which is what the guard's tests and listening passes use.

The default did not move. Sinusoidal AM was proposed as the default and withdrawn: comfort is a
fair case for it, but not an evidence-based one.

### Settled during step 4

**What can signal integrity actually verify?** → **Our own output on every platform; the
downstream path nowhere, for now.**

Checked against the installed Electron (43.4.1) rather than recalled. `audio: 'loopback'` is
documented Windows-only (`electron.d.ts`, `interface Streams`), so the original expectation that
macOS 13+ worked through ScreenCaptureKit without a native module was untrue for this version, and
there is no Linux route either. Four of Layer 2's five items have no API at all. The integrity scope
and technical-risk notes were corrected before any code was written, and the descoped items are listed under step 4 above
with their reasons.

The consequence is the shape of the feature, not just its size. Capturing before
`AudioContext.destination` measures **our own output**; it cannot see a Bluetooth codec, OS spatial
processing, enhancements, or hardware. So findings carry a scope, the downstream ones read `unknown` rather than
`ok` wherever it is unmeasured, the badge ranks `unknown` above `ok` because absence of evidence is
what it is being asked about, and the session record stores which scopes were checked so "app fine,
path never looked at" is representable rather than implied by a green tick.

### Deferred

**Exclusive-mode output on Windows (WASAPI exclusive)?** → **Deferred.**

Not decided, and not blocking: step 4 proceeds on shared mode with Layers 2–3, which is what the
other platforms need regardless. Revisit only if path corruption turns out to be common enough in
practice to be worth the cost. The case against, for whenever it is picked up again:

- Exclusive mode silences every other application, which is hard to reconcile with a companion
  meant to run in the background across a 45–60 minute work session.
- Windows-only, so Layers 2 and 3 have to exist either way — the subsystem does not go away.
- It may also disable Layer 3 on Windows: loopback capture taps the audio-engine mix, which an
  exclusive stream bypasses. **Verify this before deciding** — if it holds, the trade is between
  measuring path corruption and preventing it, not simply whether to add a native module.

### Settled

**Scheduled blocks?** → **Reminders, never autoplay.**

Session ships with manual start from the tray, a global start/stop hotkey, duration presets, and
recent-session recall. Scheduled _notifications_ — "Start focus session?" — are an acceptable
addition; a scheduled event starting audio on its own is not.

Playback follows an explicit gesture, so the user can confirm output device, volume, headphones,
integrity warnings, and whether they are currently on a call before anything sounds. It also
avoids building recurring-rule, sleep/wake, DST, missed-event, and calendar-integration machinery
before it is earned. The session record carries an optional `scheduledFor` so reminders can be
added later without redesigning Session.

**Is session tracking a private log, or does it drive something?** → **Private history only.**

Local and user-deletable:

```
startedAt
actualSeconds
plannedSeconds
presetId
completionReason
integrityStatus
initialConfiguration   what the session started from
finalConfiguration     where it ended, since Studio stays editable
edited                 whether it changed at all
```

It may drive user-configured safety behaviour — a reminder, a daily advisory, a cooldown. It must not
drive streaks, "optimal dose" recommendations, adaptive session lengths, or effectiveness scores.
There is no validated individual dose-response model here, and those features would invite
unsupported health inferences while gamifying prolonged exposure.

Call it **session history** or **listening time** in the UI, never "dose" — consistent with the
non-medical positioning above.

**User-supplied audio: key detection or manual carrier?** → **Manual authority, automatic
suggestion.**

Step 5 starts with manual carrier selection and a tuner display. Offline key detection is added
afterwards, and only ever suggests:

```
Detected: A minor · confidence 72%
Suggested carrier: A3, 220 Hz
[Apply] [Keep current]
```

Detection runs at import, returns several candidates with confidence, and never changes playback
without confirmation. Key detection is ambiguous for ambient noise, drones, modulating music,
percussion-heavy material, and detuned recordings — and a carrier that moved on its own would
drag the notches with it and risk audible transitions. This keeps the source specification's
harmonic-alignment goal without giving up the deterministic manual control the Carrier slider
already provides.

---

## Loose ends

Smaller things noticed in passing, not tied to a step.

- [ ] The binaural headphones warning runs to seven lines in a control track, and is the main
      reason the controls still scroll when that routing is active. Shortening the copy would
      fix it, but it is substantive guidance — decide before trimming.
- [ ] The footer shows the static output ceiling but gives no sign when headroom attenuation is
      actually engaged. Worth surfacing, or worth leaving quiet?
- [x] `Scope.svelte`'s modulation-index readout could exceed 100% (observed 775%) at quiet AM
      levels. Two causes, both fixed in A2c: it read the per-column _maximum sample_ rather than the
      largest magnitude, so a near-silent column's "trough" could be negative and the ratio ran
      away; and it binned at the drawing resolution, 51 samples against 218 for one cycle of a
      220 Hz carrier, so the envelope rippled at the carrier rate. Now float samples, rectified,
      binned at a whole carrier cycle.
