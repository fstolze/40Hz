# Debugging real-time audio ramp glitches

> **Resolved, 2026-09-09 — both halves, confirmed by ear.** This was written as a fresh-eyes brief
> while the defect was still open, and it is kept because the eliminations, the failed detectors and
> the traps are all still true and still expensive to rediscover. Read it as a record, not as an open
> question. §0 has the first half and §0c the second; everything from §3 onward describes the state
> of knowledge before either was found, and is left as it was written.

Written for someone arriving fresh. This records what is known, what is eliminated and with what
evidence, what I got wrong, and where I would look next — so that none of it has to be rediscovered.

**Read section 2 first.** Five separate measurement attempts produced confidently wrong answers, and
the same traps are waiting for anyone who starts by writing a detector. The fifth is in §0c.

**Then read section 0.** Late in the investigation the defect became reproducible from a script with
no pointer involved, and the maintainer confirmed by ear that the reproduction sounds like the
complaint. That changes what is worth doing next, and it invalidated one of my own conclusions.

---

## 0. FOUND — the master ramp, rescheduled on every input event (first half, Stage 10.1)

**`rampMasterToward` runs on every commit, and during a drag it scheduled a ramp per input event to
a target that never moved.** Measured in the real app: **227 ramps in four seconds, `distinctTargets:
1`, spread 0 dB.** `rampMaster` opens with `cancelAndHoldAtTime(now)`, so each of those cancelled the
one before it and restarted from wherever the gain had reached — sixty times a second, all aiming at
the value the master already had. The held value was observed **0.499 below the target**: the master
collapsing about 19 dB and being pulled back.

**Bisected, not guessed.** Driving the carrier at 60 events/s and counting dips on the master bus,
three takes each, with one piece of `commitConfiguration` removed at a time:

| Build                 | Still | Driving     |
| --------------------- | ----- | ----------- |
| unmodified            | 0     | 51, 63, 6   |
| no capture epoch      | 0     | 55, 55, 12  |
| **no master ramp**    | 0     | **0, 0, 0** |
| no soundscape write   | 1     | 46, 57, 2   |
| no automation cancel  | 0     | 51, 53, 6   |
| no steady-window push | 0     | 57, 57, 3   |

**The fix** is the rule this file already applies twice — `applySoundscape` and `refreshBedChain`
both guard on "only when it actually changes". `rampMasterToward` now skips when the target equals
the one already scheduled. Safe precisely because the target is unchanged: the ramp in flight is
heading to the same place, so the level the guard depends on still arrives.

With the guard: **0, 0, 0.** One regression test in `test/graph-taps.test.ts`, mutation-tested.

**This was Stage 10** — "something costs too much per input event" — and the cost was not CPU. It was
an automation call that cancelled itself faster than it could complete.

**Confirmed by ear** — "sound much better" — and it explains the reports as follows: the level
controls (Master, Soundscape level, Entrainment level, Duty) all move the master target, so they both
churn _and_ genuinely ramp; Carrier does not move the target at all, so its 227 ramps were pure
churn. Whether this also accounts for the two temporal signatures in §1 is not established.

The half it did **not** fix is the one where the target genuinely moves — §0c.

---

## 0c. FOUND — the same cancellation, when the target really does move (second half, Stage 10.2)

The guard above skips the reschedule only when the target is unchanged. Master, Soundscape level and
Entrainment level move it on every event, so they passed straight through and kept dipping. The
question was whether that residue was the defect or simply what a level moving sounds like.

**The control that answered it** is the one this document twice says is almost never run: hold the
distance and the duration fixed, vary only the input event rate. Same quarter-to-three-quarters
travel, same six seconds, one launch per cell, each with its own still take reading 0.

| control           | 5/s | 10/s | 20/s | 40/s | 60/s |
| ----------------- | --- | ---- | ---- | ---- | ---- |
| Master            | 0   | 0    | 5    | 14   | 18   |
| Soundscape level  | 0   | 0    | 0    | 7    | 10   |
| Entrainment level | 0   | 0    | 0    | 0    | 2    |

A count that climbs with the rate over an identical gesture cannot be the level moving. It also
disposes of the puzzle this document left open — Entrainment level "measures 0 and is not explained
either" — it is the same defect an order of magnitude smaller, and it appears at 60/s.

**Bisected** the same way, with the level still travelling the same distance at the same rate: remove
the cancellation and Master goes 8, 17, 19 → 0, 0, 0 and Soundscape level 10, 11, 7 → 0, 0, 0.

**The fix** is to stop asking the engine to hold and hold by hand: read the curve, pin it with
`setValueAtTime`, then clear. Pinning before clearing is load-bearing — the reverse leaves an instant
where the timeline has reverted to the event before the ramp, which is the step a hold exists to
prevent. `setTargetAtTime` also measures 0 and was rejected: exponential, never lands exactly, and
the headroom guarantee needs the attenuation to _arrive_ before the change it guards. After the fix
the whole ladder is 0 at every rate. Confirmed by ear: **"neither is choppy"**.

**The fifth failed detector.** To name what the engine does wrong rather than only which call causes
it, I built a probe sampling the master `AudioParam` against its target during a drag. It identified
the wrong node — it read a constant 1 — and its shortfall figure moved identically with and without
the fix. Discarded. So what the engine does with a hold cancelled every 16 ms remains unmeasured;
that it is not what a correct hold does, the bisection establishes. Same lesson as §2: a detector
built to confirm a mechanism will confirm it.

**A test that had quietly stopped testing.** `never steps, however fast the changes arrive` drags the
carrier, which after the 10.1 guard no longer moves the master target — five "fast changes" had come
to schedule one automation call. Any guard that makes work disappear can hollow out the test that
watches that work.

---

## 0b. The reproduction that led here

While a diagnostic ran — 60 seconds of `dispatchEvent` at roughly 120 events per second, **no mouse,
no pointer pipeline, no compositing** — the maintainer heard it and said it "sounded extremely
choppy".

That is the single most useful fact in this document. It means:

- **The input path is not the variable.** A synthetic stream of `input` events glitches the audio.
- **The defect is reproducible without a hand**, so it can be bisected in a loop rather than one
  listening test at a time.

Following it up, with the carrier driven from a script and the master bus captured:

**Same distance travelled, different event rates:**

| Events/s | Hz per event | Travel   | Dips  |
| -------- | ------------ | -------- | ----- |
| 120      | 0.1          | 12 Hz/s  | 33    |
| 12       | 1.0          | 12 Hz/s  | **0** |
| 120      | 1.0          | 120 Hz/s | 22    |
| 12       | 0.1          | 1.2 Hz/s | **0** |

**The measure follows event rate, not distance.** Three takes each, 0.5 Hz per event:

| Rate  | Take 1 | Take 2 | Take 3 |
| ----- | ------ | ------ | ------ |
| 5/s   | 0      | 0      | 0      |
| 10/s  | 0      | 0      | 0      |
| 20/s  | 0      | 0      | **38** |
| 60/s  | **70** | **69** | **32** |
| 120/s | 4      | 8      | 3      |

Clean at or below 10 events per second, intermittent at 20, consistent at 60. The 120/s row is not
trustworthy: `setTimeout` cannot pace reliably at 8 ms, so that run probably did not deliver 120/s.

**Arrow keys produce about 5 events per second and are reported smooth.** That is the same boundary,
from the other side.

**This resurrects Stage 10** — "something costs too much per input event" — which I had argued
against on the strength of a differential that turned out to be measuring the wrong thing.

---

## 1. The observation

Dragging a control with the mouse makes the audio glitch. The listener is the maintainer; every
report below is his, and the dates are when they were made.

**Vocabulary carries no information here.** He has said explicitly that "artefacts", "stutter",
"cut-outs" and "glitching" are interchangeable for him. Do not infer severity or a change of symptom
from which word a report uses — I did, and wasted a round of work on it.

| Date       | Report                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-02 | Dragging **Carrier after startup** produces repeated artefacts. "They stop after several seconds of continuous dragging and the drag becomes smooth." Notch depth and Notch Q behave the same way, with occasional artefacts recurring after things have otherwise stabilised. |
| 2026-09-02 | **Master, Soundscape level, Entrainment level, Duty** — all four in the same shape: "smooth at first, stuttering after a while." Soundscape level also stays quiet while being raised and then turns abruptly loud at the end of the drag.                                     |
| 2026-09-02 | **One arrow-key press on Carrier is not audible.**                                                                                                                                                                                                                             |
| 2026-09-03 | A **Depth** sweep 0→100 heard as 3 steps on one run and 1 step on the next, with stuttering during the second.                                                                                                                                                                 |
| 2026-09-07 | Stage 8 ear test: Preview start/stop **pass**; preset switch, Save/recall, History Recall **pass**; Master **zipper**; entrainment controls, Two-tone and Soundscape all **cut-outs when dragging**.                                                                           |
| 2026-09-08 | **Bed silenced** (Soundscape level at minimum) + slow Carrier drag: **still bad**.                                                                                                                                                                                             |
| 2026-09-08 | **Arrow keys** on Carrier: **smooth**.                                                                                                                                                                                                                                         |
| 2026-09-08 | After a 25 ms carrier glide: "still creates choppiness at times".                                                                                                                                                                                                              |
| 2026-09-08 | After a gap-spanning carrier glide: "still the same".                                                                                                                                                                                                                          |
| 2026-09-08 | Hesitantly dragging in a **different application** while this app plays: **no chop**.                                                                                                                                                                                          |

### Two temporal signatures, and they point opposite ways

_(Read this against §0: the rate finding may explain part of it — a hand that has settled into a
smooth drag is not necessarily emitting events at the same rate as one that is hesitating, and event
rate is now known to matter.)_

This is the most under-exploited thing in the whole record, and I did not pursue it:

- **Carrier** is _bad after startup and improves_ after several seconds of dragging.
- **Master, Soundscape level, Entrainment level, Duty** are _smooth at first and degrade_ after a
  while.

A single mechanism that does both is not obvious. It may be two defects. "Improves with use" suggests
a warm-up — a cache filling, a JIT tier rising, a pool allocating. "Degrades with use" suggests
accumulation. I tested the renderer for accumulation and found none (§3), but the audio thread was
not tested for either.

### What is _not_ affected

- Arrow keys, on the same control, through the same code path.
- Preview start and stop; preset switching; Save/recall; History Recall — all of which change every
  parameter at once through `applyConfiguration`. **A whole-configuration change is clean; a stream
  of single changes is not.** That contrast is worth more attention than it has had.
- Dragging in another application.

---

## 2. The detector graveyard

Five measurements — the fifth is in §0c, built after this section was written. All five gave
confident, wrong answers. Every one of them looked reasonable when
written.

### 2.1 Short-time RMS — reported 281 dropouts on untouched audio

Framed the master bus at 256 samples and looked for RMS dips. The output of this app is an
amplitude-modulated pulse train: it is _supposed_ to fall to near-silence forty times a second. The
detector was measuring the product.

**Rule:** any measure of this app's output must step over the modulation period. Take one value per
period (`sampleRate / modulationHz`), and take a **peak**, not an RMS.

### 2.2 Per-period peak with the carrier moving — reported 3.0–6.6 dB and named a cause

Measured a fixed 220 Hz tone through the notch cascade while walking the carrier 2 Hz per handover.
Over four seconds the notch moved eighty hertz away from the frequency being measured. The reading
was the slot tracking **correctly**. It was written up as "the fresh cascade ringing up" and had to be
withdrawn.

**Rule:** if the thing under test moves the spectrum, do not measure at a fixed frequency. Hold the
parameter constant and vary only the mechanism (here: hand over to an _identical_ cascade). Isolated
that way, the real ring-up is **0.95 dB**, flat from 100 ms down to 20 ms between handovers.

### 2.3 Sample-to-sample step — measures nothing at all

Used to test whether a carrier change produces a discontinuity. The oscillator is a phase
accumulator, so changing its frequency is continuous in phase: the waveform bends, it does not jump.
The largest sample step was **identical to the no-change control** at every rate. Worse, a test built
on it passed with the glide removed entirely.

**Rule:** to see a frequency change, measure frequency. Interpolated zero crossings give one value per
cycle — 4.5 ms at 220 Hz, fine enough to resolve a 25 ms glide.

### 2.4 Per-period peak on the master bus — I retired this one **wrongly**

A real scripted mouse drag reported 0 dips for a hesitant drag and 51 for a fast one, which is the
inverse of the complaint as I understood it. I concluded the measure was following carrier travel and
retired it.

**That was wrong, and the way it was wrong is the lesson of this whole document.** I inferred the
confound instead of testing it. The control that separates rate from distance — same travel,
different event rates — takes ten minutes and shows the measure follows **rate**, not distance, and
that a slow drag really is clean (§0). The detector works. It agrees with the maintainer's ear on the
one case where both have been applied.

**Rule:** the confound you can name is still a hypothesis. Run the control. I wrote "the second
control is almost never run" into §2.5 of this document and then, in the same session, did not run
it.

**It is still not a complete instrument.** It reports a count that correlates with a defect; it has
never been calibrated against audibility, and a dip count is not a dB of anything. Treat it as a
bisection signal, not as evidence of severity.

### 2.5 The general lesson

Every failure had the same shape: **the instrument moved with the thing it was measuring.** Before
trusting any number here, run two controls —

1. a **still** control (nothing changing) which must read zero, and
2. a **mechanism-off** control (the parameter changing exactly as much, with the suspected cause
   disabled) which must also read zero.

The first was always run. The second almost never was, and is what would have caught 2.2 and 2.4.

---

## 3. What has been eliminated, and how

Every row is a measurement, not an opinion. Tools named are in `tools/`.

| Candidate                                   | Measurement                                                                                                      | Result                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Any DSP change from the redesign            | `npm run verify` against a `main` worktree                                                                       | character-identical                                                                           |
| The notch cascade (Stage 9's diagnosis)     | maintainer silenced the bed and dragged Carrier                                                                  | **still bad — refuted**                                                                       |
| Rebuild-on-settlement being the trigger     | changed the trigger to a trailing quiet window; slow/fast/stop-start/long drags each produced exactly 1 handover | **sounded worse; reverted** (`16b9a9c`)                                                       |
| The cascade crossfade blending two chains   | complex response of a 50/50 blend at the carrier                                                                 | ≤1.4 dB                                                                                       |
| A fresh cascade ringing up from zero state  | identical-cascade handovers against the real worklet, 100 ms → 20 ms                                             | 0.95 dB, flat                                                                                 |
| The master ramp that follows a handover     | master gain target across a 20-step carrier drag                                                                 | **0.00 dB — does not move**                                                                   |
| Headroom bound recomputed per change        | 120 fresh carriers (one second of dragging)                                                                      | 0.03 ms total                                                                                 |
| The capture epoch on each settlement        | read the worklet: resets two counters                                                                            | no clear, no allocation                                                                       |
| A discontinuity at each carrier step        | max sample step, entrainment worklet, 180/100/16 ms rates                                                        | identical to control                                                                          |
| Partial params clobbering untouched fields  | `sanitizeParams` only assigns what it is given                                                                   | no bug                                                                                        |
| Renderer main-thread jank                   | `tools/jank-probe.ts`, 2 881 changes over 24 s, this branch and `main`                                           | 0 long tasks, 9 ms worst frame, identical                                                     |
| Renderer accumulation over a long drag      | 61 s of dragging at ~120 events/s, cost and heap sampled every second                                            | **flat: 8.33 ms/event, heap 9.5 MB throughout**                                               |
| AudioParam scheduling churn                 | counted every automation call during drags                                                                       | ~4.1 per change in **both** regimes; the _fast_ drag issues them 10× faster and sounds better |
| Pointer traffic with no value change        | real mouse held on the thumb and jiggled sub-pixel; pointer moved over the window                                | 0 dips against a control of 0                                                                 |
| The machine's audio path under pointer load | maintainer dragged in another application                                                                        | **no chop — it is this app**                                                                  |
| The carrier's trajectory                    | three separate changes, each measured to work (stationary fraction 67% → 13% at 80 ms per event)                 | **no audible change at all**                                                                  |

### The one real finding, which is not the cause

The **Carrier slider's resolution**: 80–1000 Hz mapped linearly onto 348 px at 1440×1024 makes one
pixel **2.644 Hz — 26.4 steps, 20.7 cents at 220 Hz**. Every other control is under 0.3 steps per
pixel. An arrow key is 0.1 Hz, 0.8 cents.

That is a real defect and explains why Carrier is the worst-reported control. It is **not** the cause
of the glitch: gliding the carrier so its path is continuous changed nothing audible.

---

## 4. What is in the tree now

- **A carrier glide** (`CARRIER_GLIDE_SECONDS` 0.025, `CARRIER_GLIDE_MAX_SECONDS` 0.12) in
  `entrainment-processor.ts` and `entrainment-core.ts`, spanning the interval since the last carrier
  event. Seven mutation-tested proofs in `test/worklet.test.ts`. It is correct reconstruction and has
  **no demonstrated audible benefit**. Reverting it is defensible.
- **`tools/audio-probe.ts`** — exploratory capture plumbing. It records the master bus by driving a
  second instance of the shipped capture worklet without ever sending it an epoch. The _recording
  path is sound and reusable_. Its **dip count is the measure discussed in §2.4**: valid for a
  controlled mechanism-off bisection — same stimulus, one mechanism removed, three takes, against a
  still control reading zero — and **not** calibrated against audibility, so it cannot say whether a
  residue matters. It bisected Stage 10.1 correctly; it cannot judge Stage 10.2.
- The notch-cascade diagnosis was **REFUTED**. Stage 10 is open. Stage 13 holds the
  slider-resolution finding.

---

## 5. Hypotheses, with confidence

### H1 — A device-level underrun, below the graph · _moderate_

Everything in the graph measures clean, and the capture tap sits before `destination`: it records what
the graph **produced**, not what the device **played**. A missed render deadline at the OS level is
invisible to every instrument used so far.

**For:** exhaustion of in-graph candidates. **Against:** dragging in another application does not
chop, so the device is not generally fragile under pointer load.

**Falsify by:** loopback capture (BlackHole) recording the device output _and_ the graph tap over the
same interval, then comparing. Both see identical legitimate parameter movement, so it cancels — what
remains is only what the OS path did. **This is the only proposal here that is not vulnerable to the
failures in §2**, because it carries its own reference instead of a threshold.

### H2 — Two different defects with opposite temporal signatures · _moderate_

Carrier improves with use; the level controls degrade with use. One mechanism doing both is not
obvious.

**Falsify by:** timing the onset. Does Carrier-after-startup recover on a fixed timescale or after a
fixed number of events? Do the level controls degrade on a timescale, an event count, or a total
distance travelled? Nobody has measured _when_ either transition happens.

### H3 — The rate of parameter-change events · **confirmed by ear and by measurement — start here**

`applyConfiguration` moves every parameter at once and is clean. Arrow keys move one parameter about
five times a second and are clean. A stream at 60/s glitches in every take, and the maintainer heard
a 120/s stream as extremely choppy with no pointer involved at all.

The falsification test in the original version of this entry was run by accident — the maintainer
overheard a diagnostic — and it came back positive. See §0.

**What to do with it:** bisect the per-event work. Each `input` event runs `commitConfiguration`,
which cancels scheduled automation, bumps a revision, computes a transition bound, ramps the master,
posts to the entrainment worklet with an `applyAtFrame`, refreshes headroom, pushes a steady window
and epochs the capture rings — about 4.1 AudioParam operations plus two worklet messages per event.
Disable them one at a time in a loop and watch the dip count. **The whole loop is scriptable now.**

One caution: the renderer is measured flat under exactly this load (0 long tasks, 8.33 ms/event and
9.5 MB heap unchanged across 61 s), so if the cost is real it is on the audio thread or in the
message path, not in the renderer's own work.

### H4 — Audio-thread accumulation · _low, but untested where it matters_

"Smooth at first, stuttering after a while" is the classic signature. The renderer is measured flat
over 61 s. The audio thread is not measurable from outside and was never checked.

**Falsify by:** instrumenting the worklets to report their own per-quantum timing and queue depths
over a long drag.

### H5 — The Stage 9 mechanism after all · _very low_

Refuted by the bed-silenced control. Recorded only so nobody re-derives it: the handover-count work
in `test/graph-taps.test.ts` is sound and the trigger really is wrong in principle, but it cannot be
what is heard.

---

## 6. Instruments, and how far each reaches

| Instrument                | Reaches                                               | Blind to                           |
| ------------------------- | ----------------------------------------------------- | ---------------------------------- |
| `npm run verify`          | the DSP core, rendered offline, static configurations | anything time-varying              |
| `test/graph-taps.test.ts` | what the graph _asks_ for, against a fake context     | what comes out                     |
| `test/worklet.test.ts`    | the real worklets running in Node, sample-exact       | the graph, the host, the device    |
| `tools/audio-probe.ts`    | the real master bus, post-compressor, during a drag   | **everything after `destination`** |
| `tools/jank-probe.ts`     | renderer main-thread cost per input event             | the audio thread                   |
| Loopback (not built)      | what the device actually played                       | —                                  |

`test/worklet.test.ts` deserves emphasis: the worklets are written in erasable TypeScript
specifically so they run under Node's type stripping, and there is a mock harness that runs the
shipped processors sample-exactly. It is the cheapest place to test an audio hypothesis, and it is
where the ring-up was finally measured honestly.

---

## 7. Traps specific to this repo

- **`npm run test:electron` has no build step.** A source change not followed by `npm run build` is
  tested against the previous bundle. Four mutations passed this way before I noticed.
- **Scripted clicks miss controls below the fold.** The Carrier slider is off-screen at the default
  window size; `page.mouse` reported a clean run because it had been clicking on nothing.
  `scrollIntoViewIfNeeded()` first, and assert `elementFromPoint` returns what you meant.
- **Preview does not stop instantly** — roughly 1.7 s of fade. A fixed sleep samples inside it.
- **The bridge has one handler slot per channel.** Calling `session.subscribe` from a probe replaces
  the renderer's own subscription and silently stops the app updating.
- **`renderOffline` is not an oracle for the master bus.** `src/integrity/measure.ts` says so in its
  opening comment, including why building an offline mirror of `graph.ts` would fail in the same
  direction as the thing under test. I proposed exactly that mirror before reading the file.
- **Never pipe `npm run lint` through `head`/`tail`** — it chains two tools and truncation hides one.

---

## 8. What I would do next, in order

1. **Bisect the per-event work (H3).** This is now a scripted loop with a signal: drive the carrier
   at 60 events per second, capture the master bus, count dips, and disable one piece of
   `commitConfiguration` at a time. Candidates in order of suspicion: the two worklet postMessages,
   the master automation (cancel + setValueAtTime + two ramps per event), the capture epoch, the
   steady-window push. Three takes per configuration, because it is intermittent near the boundary.
2. **Find the real boundary.** 10/s is always clean and 60/s never is. Pace the events properly —
   `setTimeout` cannot hold 8 ms — and find where it starts. A boundary that lands near a known
   constant (the 210 ms settle window, the 128-frame quantum, the 25 ms modulation period) would
   name the mechanism.
3. **The browser build.** The same scripted stream under `npm run dev:web`. Identical renderer and
   audio code in a different host process; if the browser is clean, it is the Electron host.
4. **Loopback (H1)** only if the above do not localise it — with the differential design in §5.

**And a caution I would give myself.** Five detectors, five wrong answers, three of them confident
enough to be written into the handoff and later withdrawn. If the next measurement does not have a
mechanism-off control that reads zero, it is not evidence yet.
