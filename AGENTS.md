# Working on this repo

Notes for anyone — human or agent — picking this up. Read [README.md](README.md) for the product,
[docs/building.md](docs/building.md) for the development commands, and this file for the traps,
invariants, and testing standards that are easy to miss from the code alone. Claude Code-specific
commands and project configuration are documented in [CLAUDE.md](CLAUDE.md). Current work and
settled product decisions are tracked in [docs/TASKS.md](docs/TASKS.md).

---

## Traps that cost real time

Each of these has already gone wrong at least once.

**Start the local server before opening an automated browser tab.**
Run `npm run dev:web -- --host 127.0.0.1`, wait for Vite to report ready,
and confirm port 5273 is listening before creating the tab. Opening it too
early produces Chrome's internal `data:` error page; the browser security
policy will not navigate that page back to localhost. Close the failed tab
and create a fresh one only after the server is ready. Do not use Reload as
a recovery path.

**Cancel a running ramp with `cancelAndHoldAtTime`, never `cancelScheduledValues` at a future
time.** Cancelling _there_ strips an in-progress ramp's endpoint, so the parameter reverts to the
event before it and jumps at the present instant; re-anchoring with `setValueAtTime(param.value,
at)` cannot repair it, because `.value` is read now rather than at `at`. The timeline left behind
reads perfectly continuous, so nothing that inspects the final curve can see it — the crossfade
fake has to record whether an operation moved the value _at the moment it was performed_.

**Changing the node graph while it renders is audible on its own.** Rebuilding the bed's filter
chain to get fresh state clicked on every change, and it kept clicking after the crossfade, the
settling time and the master ramps were all fixed. Rebuilding with _identical_ coefficients clicked
just as loudly, which is what finally named it: four nodes created, connected and later
disconnected under a running renderer. Filters that must be re-created belong in a worklet, where
fresh state is a field assignment and the node count never changes — and where the coefficients the
bound is computed from are the ones that actually run, so there is no model to reconcile.

**A fresh filter has to settle before it filters.** A chain built from zero state has not yet
accumulated the response that carves its notch, so it initially passes what it is meant to cut —
25 ms at the default settings and 118 ms at the most resonant corner the UI reaches, measured
against a settled chain over pink noise. Hand over faster than that and the slot briefly fills in,
which is audible on every change and continuous during a drag. Size the crossfade from the chain's
own pole radius rather than picking a constant, and build a chain **only on settlement** — never on
the change itself. Rate-limiting is not enough: the interval would be the fade length, 28 to 47 ms,
so a drag still produces twenty or more handovers a second and still sounds choppy. Settlement is
the right trigger because every change while a control is moving supersedes the last and never
settles, so a drag of any length produces exactly one rebuild, at the end, with the final
coefficients.

Coalescing has a consequence for the bound: a chain built for an earlier configuration keeps
sounding after settlement has promoted the new one to audible, so the bed term must come from the
bounds of the chains that are **live**, not from the configurations. Those agree until rebuilds are
deferred, which is exactly why a test written before coalescing existed can pass either way.

**A gain step over a few milliseconds is a click, whatever its size.** The guard ramp was eight
milliseconds — enough to be correct, nowhere near enough to be inaudible — and it was heard at the
start of every press, with the release at the end of one just as abrupt. Attenuation has a deadline
and must land before the change it guards, so lengthen the guard rather than the ramp; an increase
has no deadline at all and should simply take longer. Correct and inaudible are different
thresholds, and only one of them shows up in a test.

**Retire a fading node when its fade has _landed_, not when its gain reads zero.** A chain built a
moment ago has not begun fading in yet and reads zero, so a value-based check disconnects it while
it is still scheduled to become audible — the crossfade it belonged to then sums below one and the
bed develops a hole exactly when input is arriving fastest. Track the scheduled silence time.
Testing this needs the fake to model _connection_ state too: summing every gain ever created still
totals one while the audio one of them described has been cut loose.

**`disconnect()` removes a node's outgoing edges only.** Retiring a filter chain by disconnecting
its sections leaves `source → firstSection` attached, so the source accumulates a connection and a
live biquad per chain ever built. Disconnect from the source side explicitly.

**Never retune a biquad that is carrying signal.** A filter holds state fitted to its old
coefficients, and writing new ones leaves that state as an excitation the new denominator rings on.
Measured on the real `BiquadFilterNode`, 19% of notch transitions across the admitted space
exceeded the larger of the two static L1 bounds — the worst by 265x, and 11.6x within values the UI
alone can produce. No peak bound survives it. Build a fresh chain instead, assign its coefficients
before it processes anything, and crossfade with gains that never sum above one; then each chain's
own bound holds and the largest of them bounds the mix.

**Re-sending an unchanged value can still restart something.** `setColor` on the noise worklet
rebuilds both generators from fixed seeds, so telling it the colour it already has replays the bed
from its first sample. That was harmless while only `setSoundscape` sent it, and became audible the
moment a single commit path sent the whole configuration on every change — a slider drag restarted
the bed about thirty times a second, heard as a fluttering, bouncing bed. Any setter that owns
state has to be idempotent; deciding not to send is an optimisation on top, not the fix.

**Some defects are only reachable by listening.** The one above survived 777 passing tests, an
Electron suite driving the shipped worklet, and a packaged smoke test, because every one of them
asserts on values and none of them has ears. The signal was correct sample by sample; what was
wrong was that it kept starting again. Budget an ear test for anything that changes how often audio
parameters are written, and treat "no test caught it" as information about the tests.
The failed measurement approaches and the ramp-rescheduling bisection are preserved in
[docs/audio-ramp-debugging.md](docs/audio-ramp-debugging.md).

**A `<dialog>` keeps its children in the DOM whether or not it is showing.** A panel rendered
inside one unconditionally mounts at app start, loads its data once, and is stale every time it is
opened afterwards — the history dialog showed no sessions at all. Render the element only while it
is open; that also lets each panel just load in an effect.

**`prefers-color-scheme` is not readable from an Electron renderer.** Measured on Electron 43.4.1
with macOS in Dark mode: `matchMedia('(prefers-color-scheme: dark)').matches` is `false` in the
renderer while `nativeTheme.shouldUseDarkColors` is `true` in main, and setting
`nativeTheme.themeSource` to `dark`, `light` or `system` moves neither. The renderer reports light
in every case. Anything deriving a theme from the media query therefore resolves "follow the system"
wrongly on every dark machine — and worse, disagrees with the window background main already painted
from `nativeTheme`, which is a startup flash produced by two sources rather than by timing. Main
reads the OS and publishes the answer; the renderer applies what it is told. The media query is
still right in a real browser, so `dev:web` keeps using it.

**Redirecting `userData` does not isolate the OS.** `app.setLoginItemSettings` writes machine-level
state that no test directory contains, so an Electron suite could rewrite a real login item on the
machine running it. Anything reaching outside the app must be inert unless `app.isPackaged` — in
development the executable is Electron itself, so applying it would be wrong as well as invasive.

**Announce data changes from the store, not from the IPC handlers.** The coordinator writes history
directly, so a notification wired to the handlers carries deletions and misses every completed
session. The store owns the data and is the only place that sees every write — and it must announce
after the write succeeds, never before, or a rolled-back change reaches every window.

**One preload handler slot per channel means the renderer must fan out.** The slot is deliberate —
one per call would stack and deliver a message once per subscription ever made — but it also means
the last component to subscribe in a window displaces the one before it, and closing a dialog
leaves its replacement installed. `src/renderer/lib/fan-out.ts` is the only thing that should call
those bridge methods, and every subscription returns an unsubscribe that components must run on
teardown.

**Do not offer a control that stores a preference nothing will ever apply.** Launch at login was
offered in development with a promise that it would take effect once installed; it could not,
because the installed build reads the OS at startup and corrects the file, overwriting the stored
value first. Either the control does something where it is shown, or it is not shown.

**A compensating action can fail too.** Undoing an outside change after a failed write is not
enough on its own — check what the undo actually achieved, and if the two now genuinely disagree,
say so in the error, because the file that would have recorded the truth is the one that could not
be written.

**The OS is the source of truth for OS settings; read it, do not re-impose it.** Reasserting a
stored login-item preference at startup overrides a user who changed it in System Settings, and it
means merely launching the app writes machine-level state — which the packaged smoke test does on
every run, with a temporary profile that isolates files and nothing else. Reconcile the file to the
OS at startup and write only when the user asks.

**Anything reaching outside the app has to be undone when the write it accompanies fails.** The
login item was changed before the settings file was written, so a refused write left the machine
carrying a setting nothing recorded and the form showing the old one.

**A subscribe-shaped API here returns the current value and calls back only on later changes.**
`session.subscribe`, `presets.subscribe` and `settings.subscribe` all work this way, deliberately,
so no change can pass unseen. Using the callback alone is silent and wrong: every surface sits on
its defaults until something else changes them, so stored settings did nothing after a restart.
Adopt the resolved value as well as the callback.

**A frameless window is still closable.** macOS installs a default menu with Cmd+W and Alt+F4
closes anything on Windows, so `frame: false` buys no protection. A window nothing recreates must
prevent its own close, or one keystroke disables the feature until the app restarts.

**Writing a `$state` object field inside an `$effect` makes that effect depend on it.** Svelte
proxies the value, so the write reads it too, and the effect re-runs until Svelte aborts it with
`effect_update_depth_exceeded`. `PresetBar` applies the default preset from an effect and has
always been fine, because everything it touches is written and never read — until a call added
there passed `engine.params` as an argument, which reads it. Pass what the graph itself holds
rather than the UI's copy, or take the value outside the effect.

**The popover dismisses itself on blur, which breaks any test that shows it and then does
something else.** `setHeight` deliberately skips placement while the window is hidden, so a resize
that lands after focus moved grows the content and leaves the window where it was — observed as a
height going 283 → 523 with the position unmoved. Both are the product being correct. A test that
needs the window visible has to re-establish that itself and retry, and it must set any stray
position _after_ the `show()`, since showing places the window and would otherwise be the thing
under test. This has now cost two debugging rounds, one of them on Linux where it read as a
compositor problem.

**A hidden Electron window cannot tell that it was shown.** `show()` fires neither
`visibilitychange` nor `focus` in the renderer, and `document.visibilityState` reads `visible` the
whole time the window is hidden — all three verified against the production build. A window that
is hidden rather than closed between uses therefore cannot refresh itself on display; the owner of
the data has to push.

**`isDestroyed()` immediately after `close()` is always false.** Destruction is asynchronous, so
reading it synchronously proves nothing — a test written that way passed with the fix removed.
Proving a window survived a close needs a settle, not a poll: polling returns on the first check,
before destruction could have happened either way.

**`npx asar extract-file <archive> <path>` writes into the current directory.** Run from the repo
root to inspect the packaged `package.json` and it silently overwrites the real one with the
stripped version — no scripts, no devDependencies, and `npm run` stops working. Extract into a
scratch directory, or use `asar list` / `asar extract` into an empty one.

**Packaging can break the app with every test still green.** `out/` and the shipped asar are the
same code in different shapes: the renderer and the AudioWorklets move inside the archive, and
`addModule()` fetches those through Chromium's loader rather than Node's `fs`. If that stops
working, audio silently never starts. `npm run dist:dir && npm run test:packaged` is the only thing
that proves otherwise — run it after touching the build pipeline, asset paths, or anything the
renderer loads by URL.

**A constructed `Tray` is not a visible tray on Linux.** Where the desktop provides no
StatusNotifierItem host — GNOME without the extension — `new Tray()` returns an object, throws
nothing, and displays nothing. There is no API to ask. Never make lifecycle depend on it: doing so
hid Studio behind a tray that did not exist and left a session playing with no way to stop it.

**Half the `Tray` API is platform-specific, and the typings do not say so.** `getBounds()` and
`popUpContextMenu()` are macOS and Windows only; `setTitle()` is macOS only; balloons are Windows
only. `tray.on('click')` is never delivered on Linux. Calling `setContextMenu()` on macOS also
takes over the left click, which is why the menu is popped up explicitly there. Check the
platform matrix in the Electron docs before reaching for a `Tray` method — the compiler will not.

**`node:test` has no default timeout.** A hung test, hook, or Electron shutdown runs until the CI
job limit rather than failing. Both suites pass `--test-timeout`, and the Electron hooks carry
their own, since the flag does not cover hooks. Verified by hanging each deliberately: both fail
at the limit and exit non-zero.

**A green test step does not prove tests ran.** `node --test` exits 0 when its glob matches
nothing, so a suite that moved, or a directory that failed to check out, reads exactly like a
suite that passed. `test:electron` names its file explicitly, since a missing explicit path does
exit non-zero, and CI asserts the test files exist before believing any of it. When you read a
green run, check the assertion count, not the tick.

**Never pipe `npm run lint` through `tail` or `head`.** It runs
`eslint . && prettier --check .`. Truncating the output hides eslint entirely, including
warnings that reveal a broken edit. Run it whole, or run `npx eslint .` separately. This hid a
commit that claimed a fix it did not contain.

**Assert that a string replacement applied.** Prettier reflows code between edits, so a pattern
that matched an hour ago silently matches nothing now — the edit vanishes and everything still
passes. Every scripted replacement should fail loudly:

```python
assert s != before, 'replacement did not apply'
```

**Prettier can oscillate on Markdown.** A wrapped line beginning with a code fragment, such as
`min)` continuing an expression from the line above, gets de-indented on each run and re-flagged
on the next. It never converges, so CI fails forever. Keep expressions on one line inside list
items. This broke `main` for two commits.

**Filter before normalizing, not after.** `normalizePreset` clears `builtIn` on everything it
returns, so a `.filter(p => !p.builtIn)` placed after it never matches. Built-ins would have been
persisted as user presets.

**A snapshot must be copied, not referenced.** `SessionConfiguration` and its nested `params` and
`soundscape` are mutable, and Studio stays editable during a session, so holding a reference
means the "initial" configuration quietly tracks later edits. Use `snapshotConfiguration`. This
has been reintroduced twice — once in `completeSession`, once in `normalizeSessionRecord` — so
assume it will happen again and test for it.

**A copy must be deep enough to matter, and its test must reach the nesting.** A spread copies
one level: `{ ...preset }` still shares `params` and `soundscape`, and `{ ...record }` still
shares both configurations — so a caller can mutate main-process state through a value it was
merely shown, outside the serialized queue and without anything reaching disk. Use
`snapshotPreset`, `snapshotRecord`, `snapshotConfiguration`. The test that missed this asserted
only a top-level scalar, so it passed for weeks while the nesting was wide open.

**Node runs each test file in its own process.** Setting `process.env.TZ` at the top of a file
cannot leak into the rest of the suite. That is what makes `test/history-dst.test.ts` safe.

---

**`svelte-check` prints `ERROR` in capitals, and `.svelte` files are not typechecked by `tsc`.**
Filtering `npm run typecheck` through a lowercase pattern therefore shows a clean run over a
failing one — an undefined identifier in a component reached the browser as a `ReferenceError` in
an animation loop, with the gate apparently green. Read the `COMPLETED ... N ERRORS` line, which is
the only summary either tool prints, and never pair a filter with an unconditional "ok" message.

**A threshold calibrated over part of the parameter space will warn about correct output.** The
integrity checks in `src/integrity/measure.ts` cost five rounds of this. `sanitizeParams` admits
modulation from 0.5 to 200 Hz, carriers from 20 Hz to 8 kHz, duty from 2%, any taper and any depth,
and the sample rate is whatever the OS gives — 22.05 and 32 kHz are reachable. Sweep _all_ of those
together before fixing a number. Each partial sweep produced a floor that the next unswept corner
slipped under: omitting the carrier put the floor 0.85 percentage points too high, and omitting low
sample rates missed that an 8 kHz carrier at 32 kHz has four samples per cycle, half of them at
zero crossings.

The deeper lesson is that the measure was wrong, not the number. Anything asking _how much of the
time_ carries signal will fail here, because correct output can carry it for very little: a 2% duty
cycle is silent 98% of every period by design. When a threshold needs its third patch, change what
is being measured. Record the sweep and its numbers in a comment beside the constant — every
threshold in that module now has one.

## Invariants worth understanding before changing audio

**`envelopeGain` carries playback ramps; `masterBus` carries level.** They must stay separate.
`rampMaster` calls `cancelScheduledValues`, and `refreshHeadroom` reaches it from both
`applyParams` and `applySoundscape` — so an envelope living on the master bus is wiped the moment
the user touches any control. Since Studio is editable during a session by decision, that is a
certainty, not a risk.

**A configuration change is carried by three mechanisms and none is simultaneous.** AudioParams
land exactly, the worklet adopts on a render-quantum boundary, and its gains then approach their
targets through a one-pole smoother. Both endpoints of a change being under the ceiling says
nothing about the path between them: a source bound falling 2 → 1 against a master rising 0.4 → 0.8
reaches 0.95 at 50 ms. Bound the whole transition with `transitionPeakBound`, quantise the landing
so the first two mechanisms coincide, and let the worklet's acknowledgement — not the scheduled
time — decide when a configuration is audible. Scheduled time is not proof: nothing bounds port
message delivery, and treating it as proof lets the next change relax the attenuation that was
covering the difference.

**"Adopted" and "settled" are different events, and only the second one counts.** Adoption says the
frequencies and routing changed; `amGain` and `twoToneGain` are still between the old and new
values for another 210 ms after it. So the worklet snaps them to their targets and reports
settlement separately, and only that promotes a configuration to audible or releases the master.
Snapping rather than approaching asymptotically is deliberate: `BOUND_MARGIN` covers the notch
chain's bed term and nothing else, so a residual on the source gains is covered by nothing at all —
a final bound of exactly 1 plus any residual exceeds 1. Prove the snap by measuring the output, not
by reading the message: a worklet that posts `settled` while still approaching satisfies every
message-shaped assertion, so the Electron test drives a target of zero and requires exact silence.

**One pending configuration is not the same as everything still sounding.** The smoother can be
carrying a configuration that has already been superseded — A settles, B is adopted and still
smoothing, C replaces B — so a bound over the settled one and the latest request alone misses B
entirely. `0 → 0.6 → 0` leaves the source near 0.6 while both ends read zero. Keep a componentwise
running maximum of everything committed since the last exact settlement, and clear it only when the
newest revision settles. A running maximum rather than a list, because a slider drag commits once
per pixel.

**A settlement must match the pending revision exactly.** At-or-above lets a malformed or future
reply promote a configuration and release the attenuation with nothing having proved that
configuration settled. Every other revision fails closed — the guard stays on.

**Every path that moves the master reads `effectiveMasterLevel`, and that is defined from the
transition bound.** `setMasterLevel`, `start` and `startSession` each computed the endpoint level
directly and could ramp straight past a change still in flight. Defining the level from the active
configurations instead makes the guard impossible to bypass rather than something each call site
has to remember.

**An imported bed is normalised last, after every transformation.** The pipeline is sanitize,
reject, transform, then measure and normalise — and the order is load-bearing rather than
stylistic. An equal-power overlap of two same-polarity samples near unity reaches √2, so a buffer
normalised before the loop fold comes out of it above unity, silently undoing the thing that keeps
`worstCaseSourcePeak` true for a file. RMS is measured there too, for the same reason: taken
earlier it describes a buffer that no longer exists.

**Equal-power is right for the loop seam and wrong for a filter crossfade.** Tail and head of a
recording are uncorrelated, so the fold adds power and cos/sin holds the level. Two filter chains
carrying the same signal are correlated, so their gains must sum to one instead. Same operation,
different statistics, opposite answer.

**Fold the loop seam so the new head begins as the tail.** Getting the direction backwards makes
the seam worse rather than better — and it still looks like a crossfade. The last frame before the
loop point must be `original[frames - 1]` and the first after it `original[frames]`, which are
adjacent in the source; starting the fold from the original head leaves the splice exactly where
it was. Caught by asserting the discontinuity rather than the shape of the fade.

**Acoustic boundaries live on the AudioContext timeline, never on timers.** A session's whole
envelope is scheduled in one call at start. Event-loop and IPC latency cannot move a boundary
already on the audio clock; a timer plus a message can, and a late fade racing a finalize timer
produces audible nonsense.

**The fade _lands_ on the planned end, it does not start there.** Otherwise the audio, the phase
machine, and the stored record disagree three ways about when a session ended.

**Both gains only attenuate.** That is what keeps the headroom guarantee — measured at the
sources in `worstCaseSourcePeak` — true at the destination.

**"The notches only cut" is a claim about magnitude response, not about peak amplitude.** A cut
biquad still rings, and a ringing filter can push an individual sample above its input. The bed
term in `worstCaseSourcePeak` was `soundscape.gain` alone on the strength of that phrase, and the
headroom test summed raw noise with no notch chain at all — so neither could ever have observed
the overshoot. Measured on the chain: white noise reaches 1.82x and a full-scale square 2.10x. The
bed term now carries the L1 norm of the cascade's impulse response, which is the worst-case peak
gain of a fixed, zero-state LTI filter for any input bounded by one.

Two things about that number. It is computed **per configuration**, not fixed once: the worst chain
in the whole parameter space bounds at 3.54x and would cost 11 dB everywhere, while the
configurations people run cost between nothing and 2.6 dB — five of the six offered presets are
unaffected. And it is a bound on a **model** of `BiquadFilterNode`, not on that node; the
equivalence is established by measuring the real one, and calling `dsp/biquad.ts` "the real chain"
is how that gap gets assumed away.

**Claim a generation token before any `await`, and recheck after each one.** Ordering must follow
when an operation was _requested_, not whichever await resolved first. Otherwise a stop the user
issued later loses to an older start, and the audio keeps playing after they asked for silence.

---

## Invariants worth understanding before changing storage or IPC

**Close the window last, not first.** Anything that has to happen with the renderer alive — a
clean audio stop, a final record — must run before the window is destroyed. A close handler that
ends the app should raise `app.quit()` and leave the closing to the quit path, rather than
allowing its own close and quitting afterwards; by then the executor is gone and every stop fails.

**Quitting is a boundary that has to be waited for.** `app.quit()` does not wait for anything in
flight, so a session finalized on the way out loses its record to the process exit. Finalize on
`before-quit` with `preventDefault()`, while the windows are still open and the audio renderer can
still answer, then quit again — with a timeout, so a renderer that will never answer cannot leave
the user unable to quit.

**Never report durability you do not have.** A write that did not happen must throw. The
coordinator clears its checkpoint on a successful append, and that checkpoint is the record's
only other copy — so a false success loses the session at the next start.

**Memory must match disk.** Roll back in-memory state when a write fails, or a retry will see its
own optimistic entry, deduplicate it away, and never persist anything.

**Only `ENOENT` means "nothing here yet".** Any other read failure may be hiding real data that
simply could not be read, so the file must be left alone rather than treated as an empty
writable store.

**Disk, IPC, and `localStorage` are all untrusted input.** Normalize at the boundary where the
data arrives. Files survive across versions and can be hand-edited; valid JSON is not necessarily
an object, and a file containing `null` once crashed startup.

**Run the gates after the last edit, including the ones to a document.** A commit here claimed
lint had been read unpiped, and it had — before a final documentation edit that `prettier --check`
rejected. `prettier --write` on the one file is not the same gate: a paragraph indented inside a
list item can be a construct Prettier's own output does not satisfy, so it has to be restructured
rather than rewritten. `npm run lint` is the check that counts, and it counts last.

**The in-app browser's console buffer survives reloads, and `console.clear()`.** Reading it after
a reload shows errors from the _previous_ load, which reads exactly like a fix that did not work.
It inverted two conclusions in one session: a loop that was already fixed looked persistent, and a
defect I had introduced looked pre-existing when the same stale lines appeared against an older
tree. Close the tab and open a new one for a clean buffer, and treat a line number that no longer
matches the file as the tell.

**A `$state` value cannot cross IPC.** Svelte 5 deep-proxies `$state`, and structured clone
refuses a proxy — `Error: An object could not be cloned`. Anything a renderer sends to the main
process must be `$state.raw`, or a copy built by a snapshot function, as `currentConfiguration()`
already does. The failure is silent where it matters: the integrity report is best-effort, so the
rejection was swallowed, the session recorded no coverage, and nothing in either console said why.
It took a page-console probe to find. `$state.raw` is usually the honest shape for such a value
anyway, since a payload replaced wholesale has nothing for deep reactivity to earn.

**The `dev:web` history key carries its version.** `localStorage` has no file header to put one
in, so `fortyhz.history.v<n>` is the version, and `browser-history.ts` is the only module that
reads or writes it — two copies of a storage format is a format that drifts, which is how records
written in a browser kept a coverage claim the desktop store had already been taught to correct.
When the meaning of a record changes, bump the key, add the old one to `SUPERSEDED_KEYS`, and
correct on the way across. Deleting the old data instead is defensible for development records,
but it has to be a decision rather than an omission.

**Only the coordinator writes history.** There is deliberately no `history.append` on the
renderer surface — exposing one would let any renderer forge or duplicate records however well
the payload were normalized.

**Attach `once('destroyed')` once per `WebContents`, not once per call.** Both session
subscription and executor registration re-run through the same window on a reload, so a listener
per call accumulates dormant closures and eventually trips Electron's max-listener warning. Track
which windows already carry one.

**Validate every IPC sender, by frame identity rather than URL.** A renderer can navigate a child
frame, so a URL check can be satisfied by content the app never loaded. Audio-driving channels
are checked against the one nominated `WebContents`, not merely "a window we opened".

**Adding a channel means adding it to both e2e surface tests.** `electron/preload.ts` is covered
by an "exposes exactly the surface" assertion and by a sweep that calls every method from an
untrusted window. Neither enumerates groups dynamically, so a new group is silently unproven —
the test keeps passing while claiming to be exhaustive.

**The built-in presets are code, not data.** `presetStore.list()` returns saved presets only, so
any picker has to render `[...BUILT_IN_PRESETS, ...saved]`. A picker fed from the store alone is
empty on a fresh profile, which is to say the surface does nothing on first run. Anything that
_names_ a session record uses `nameablePresets` instead, which adds the retired built-ins in
`LEGACY_PRESETS` — without them, a record of one reads "Deleted preset".

---

## Testing standards

**Prove the test fails without the fix.** Reintroduce the defect, watch the assertion fail,
restore. This has repeatedly caught tests that asserted nothing — and once caught a real bug the
weaker version had been passing over (`scheduleOpenEnvelope` reading a stale value).

**Rebuild before every Electron mutation run.** `npm run test:electron` has no build step, so a
mutation left only in `src/` runs against the previous bundle and the test passes — which reads
exactly like a test that covers nothing, and is the one direction of error this discipline cannot
catch on its own. Four Electron-test mutations passed this way before the rebuild made all four fail.
`npm run build` between the edit and the run, every time.

**Assert behaviour, not that a method was called.** A fake that records calls without modelling
their effect proves almost nothing. The `AudioParam` fake models the automation timeline and is
evaluated as a curve, because continuity across a stop is the property that matters.

**Inject the clock, the scheduler, the storage, and the transport.** Everything in `src/session/`
and `src/audio/` is testable in Node with no Electron and no browser. Keep it that way; when a
fix seems to belong in Electron-only code, look for the part that does not.

**Follow the core-first pattern.** Steps 1 and 2 were built as verified logic first, UI second.
Step 3 continues it. Anything that needs a live `WebContents` is the exception, not the model.

---

## Environment and repository facts

- **The tree is LF everywhere**, pinned by `.gitattributes` (`* text=auto eol=lf`) rather than by
  each machine's `core.autocrlf`. Prettier's `endOfLine` default is `lf` and `npm run lint`
  checks formatting, so a CRLF checkout fails on every file for a reason unrelated to the code.
  PNG and icon formats are marked `binary` so nothing rewrites their bytes.
- **Distributables are built by hand, per platform, and CI never packages.** Do not add a release
  workflow, a publish step, or a tag trigger. `npm run dist` on the platform in question is the
  whole process, followed by `npm run test:packaged`.
- **Keep shared branches linear.** Rebase local work onto upstream before pushing; do not create
  merge commits for routine synchronization.
- **CI runs Node 24 on Ubuntu; local development is on Node 26 on macOS.** Timezone-dependent
  tests must pin their own timezone, because CI is UTC and every day there is 24 hours long.
- **`npm test` needs no `npm install`** — the engine and its suite have no runtime dependencies.

### Which gates to run

`test`, `typecheck`, and `lint` always. Beyond those:

| Touched                     | Also run                                                                    |
| --------------------------- | --------------------------------------------------------------------------- |
| `src/audio/**`              | `npm run verify` — a measurement report, not pass/fail; compare the numbers |
| `electron/**`, preload, IPC | `npm run build`, then `npm run test:electron` — the bundle and the boundary |
| renderer UI                 | `npm run dev:web` and drive it; Studio must stay runnable without Electron  |

A session runs for at least ten minutes at production durations, so natural
completion cannot be watched by hand without help. A development build honours
`?durations=0.15` (minutes), which fits a whole session into a few seconds. It
is gated on `import.meta.env.DEV` and absent from a production bundle —
confirmed by grepping the built assets, not assumed.

---

## Audit tools, which are not gates

Six scripts in `tools/` drive the real product and report a list of checks, exiting non-zero if any
fails. They remain useful because the questions they answer cannot be asserted from source:

| Tool                | Asks                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packaged-audit.ts` | Does the **packaged** app in `dist/` still navigate, theme, open dialogs, play, and keep what it saved across a restart, without a console error? Needs `npm run dist:dir` first                 |
| `a11y-audit.ts`     | Landmarks, accessible names, focus visibility and return, keyboard traversal, the shortcut contract typed at the running app, 200% zoom, reduced motion                                          |
| `cross-flow.ts`     | Seven realistic workflows chained in one launch — the state that leaks between flows, which isolated tests cannot see                                                                            |
| `tray-probe.ts`     | What the tray is actually told during a preview and during a session, plus hide and show                                                                                                         |
| `audio-probe.ts`    | **What the app actually plays while a control is dragged.** Records the master bus through a second instance of the shipped capture worklet, and counts modulation periods that lose their pulse |
| `jank-probe.ts`     | Renderer main-thread cost and long tasks while a control is dragged                                                                                                                              |

They are deliberately not in `npm run verify` or CI: five need `npm run build`, and
`packaged-audit.ts` needs `npm run dist:dir`. Their value is a careful read rather than a green
tick.

Two things to know before trusting one:

- **`a11y-audit.ts` and `packaged-audit.ts` must not subscribe through the bridge.** `session.subscribe`
  has one handler slot per channel, so a probe that subscribes replaces the renderer's own
  subscription and stops the app updating while reporting success. Read the UI instead.
- **Establish that keystrokes are arriving before testing any of them.** One `a11y-audit.ts` run in
  six failed every keyboard check at once, because the Electron window did not hold the keyboard
  after previous instances shut down — no key event arrived, and the audit reported six product
  defects. The tell was that a _native_ button also failed to activate on Space, which is Chromium's
  behaviour and not this app's. Focus the window, press Tab, and confirm focus moved.
- **`audio-probe.ts` measures per modulation period, not per fixed window, and always takes a
  baseline.** Its first version framed at 256 samples, took RMS, and reported 281 dropouts on an
  untouched signal: it was detecting the 40 Hz pulse train, which is the product. Any measure of
  this app's output has to step over the intended gap, and the untouched baseline — which reads 0 —
  is the thing that proves it does.
- **Preview does not stop instantly.** The envelope fades over roughly 1.7 s and the transport keeps
  saying "Stop" until the coordinator reports idle. A fixed sleep samples inside the fade; poll for
  the label. An early version of the accessibility audit reported four product defects that were all
  this one mistake.

## Two test suites, deliberately

**`npm test`** is the Node suite: fast, and runnable with no `npm install` at all, because the
engine has no runtime dependencies. That property is real and worth protecting — the e2e spec
lives in `e2e/`, outside the `test/**` glob, precisely so it cannot break it.

**`npm run test:electron`** is the Electron smoke test: `node:test` again, with `_electron` from
an exactly pinned `playwright` for lifecycle and window control. Same runner, same assertions, one
extra dev dependency — not a second test framework. Playwright downloads no browsers; it launches
the Electron the project already depends on.

It runs against the **production build**, so `npm run build` comes first, and CI does them in that
order. Under Linux it needs a display: `xvfb-run -a`.

Verified on all three targets: macOS and Windows 11 by hand, Linux in CI. Windows is the one
worth keeping green deliberately — it is where `app.setPath('userData', …)` before the ESM import
and the teardown's recursive delete of a directory Electron just held are most likely to break.

Keep it to genuinely cross-process behaviour. It drives `window.desktop` exactly as the UI does,
and never reaches for the coordinator or the store directly — asserting main-process internals
would prove the internals work while leaving the boundary, the only untested part, untested. Core
logic belongs in the Node suite, where it is faster and far easier to drive into failure.

`e2e/bootstrap.mjs` redirects `userData` to a temporary directory before importing
`out/main/main.js`, so the shipped code carries no automation flag or test branch at all. A
production build with a way to enter test mode is a production build with a way to enter test
mode.

A test that only speaks from the trusted window tests nothing about trust. The spec opens a
second `BrowserWindow` with the same preload so the guards are exercised at all — and enumerates
every method off the bridge rather than naming a few, so a channel added later without a guard
fails by default instead of quietly widening the hole. Probing a representative sample is not
coverage: a guard missing from one channel is exactly the shape this has to catch.

Two traps in writing that probe. A callback is not structured-cloneable, so passing one to a
method that does not take a listener fails at the IPC boundary _before_ the guard runs — which
reads as a refusal while proving nothing. And the untrusted window is refused on its WebContents
id first, so `isMainFrame()` is never the deciding check; it is defence-in-depth against a future
change that enables subframe preloads, and the spec asserts subframes get no bridge at all rather
than pretending the frame check is covered.

Same reasoning throughout: assert what reached the _disk_, not what the store says it holds, and
that a change was _pushed_ to a subscriber rather than that subscribing answered. Poll for the
durable state — the store updates memory before awaiting its write, so reading the file the
instant the record appears is a race a slow filesystem loses. Each assertion here was confirmed
by breaking the single thing it covers.

What it caught on its very first run: stopping a preview did nothing. The single stop control
routed to `stopSession`, which no-ops without a session, so the audio carried on and the state
never changed. Every fake-driven test passed, because none of them crossed the boundary where the
UI's one button meets the coordinator's two methods.

---

## Review findings that keep recurring

Worth checking for directly before submitting:

- An object presented as a snapshot that is actually a live reference, or copied only one level
  deep.
- Success reported for something that did not happen — an unwritten file, a skipped retry.
- A message on a versioned protocol that forgot to carry its generation.
- Untrusted input reaching a consumer without normalization.
- A test that asserts a call was made rather than that the behaviour holds, or that checks a
  scalar where the exposure is nested.
- A guard checked before an `await` and not rechecked after it.
- An optimistic UI update with no rollback, so a rejected write leaves the control claiming a
  setting that is not in force.
- An assertion about platform-dependent UI written from one platform. Both e2e suites run on macOS,
  Windows and Linux, and copy that differs by platform has to branch on `process.platform` or it
  fails on the two you did not run. Asserting the shape _and_ the reason is worth it — the control
  is absent for different reasons in a development build and on Linux.
- A **filesystem failure staged by permissions**, which is not portable. Making a directory
  read-only does not stop file creation on Windows, so three smoke tests that staged a store write
  failure that way staged nothing there and asserted a failure report that never came. Block the
  store's own atomic-write temporary instead — `<file>.<main pid>.tmp`, the name
  `electron/store.ts` builds, with the pid read from the **main** process — created empty and made
  read-only. Opening an existing read-only file for replacement is refused everywhere.
- A **canvas assertion written against absolute colour channels**, which pins one theme. "Green and
  blue above 100 is the trace" held for the dark palette and counted thousands of the light theme's
  grid pixels as signal. Resolve the token the component actually draws with — fill a one-pixel
  canvas with `getPropertyValue('--chart-signal')` and match that, which also lets the browser parse
  whatever CSS colour syntax the token uses.
- A test that passes on this machine because the machine cannot reach the failing case — a
  top-anchored tray never exercises a bottom clamp. Say so in the test rather than letting it read
  as coverage.
- A payload invented rather than taken from the type. Anything crossing IPC is typed `unknown` and
  rebuilt by a normalizer, so wrong field names are silently replaced with defaults and the test
  passes while proving nothing about what it sent.
- A wait whose condition is already satisfied by earlier state, so it returns immediately and
  proves nothing — in an e2e suite that shares one profile, "a completed record exists" is
  satisfied by any previous test's record. Capture what exists first and require something new.
- A local named `before` or `after` in an e2e file: those are the node:test hooks, and shadowing
  them fails at runtime rather than at typecheck.
- A test that feeds a function the very value it computes internally — passing `renderOffline`
  output to a check that renders the same reference itself. Both sides then carry identical
  numerical residue, so the assertion holds under the bug as well as under the fix. Perturb the
  input, or the test proves only that the code is deterministic.
- An assertion that would pass whatever the code did: checking a finding that reads the left
  channel to prove something about the right one. Where a test builds a signal by taking one apart,
  add the control — the same reconstruction _without_ the fault, asserted to pass — or a lossy
  teardown produces the expected failure for its own reasons.
- A metric that a wrong signal can satisfy. Averaging two sidebands hides one vanishing while the
  other doubles; correlation and side-to-mid energy both ignore channel level for orthogonal tones,
  so a dichotic pair can lose an ear unnoticed; level-based checks cannot see a tone at the wrong
  frequency at the right level. Comparing the whole spectrum against the reference catches all
  three without having to predict the failure.
- `peakLevel` and anything else built on comparisons walks straight past `NaN`, because every
  comparison with it is false. Captured audio needs a finiteness check before the metrics, or a
  dead channel measures as its healthy neighbour. **Every scan needs its own guard, not one per
  module** — this has been walked into three times in `src/integrity/`, twice in the same file and
  once directly below a comment describing it. `Math.abs(a - b)` is NaN and is never greater than
  the running worst, so two buffers compare as identical; `if (v > peak)` skips the sample
  entirely. Write `Number.isFinite` into the loop.
