# Using 40 Hz Studio

This guide covers every control, how sessions and history work, the settings, and fixes for
common problems. For download and first launch, see the [README](../README.md#install). The
installed app is named **40 Hz**.

The app has two surfaces:

- **Studio**: the main window, where you build and hear a sound recipe.
- **The tray popover**: a small panel for starting a session without opening Studio.

## Studio

The header runs left to right: the **Studio** and **History** tabs, the preset picker with
**Save as…** (or **Save**) and **Delete**, **Preview**, the **Master** slider and output ceiling,
the sample-rate badge, and **Settings**. Under it are the preset's description and the
signal-integrity status line.

Below those are the **Envelope** and **Spectrum** charts, the **Session** strip and the
**Sound recipe**.

Changes to the recipe apply to sound that is already playing, so nothing needs restarting. Most
changes are smoothed: the carrier glides to its new pitch, routing switches fade out and back in,
and levels ramp. Changing the envelope shape, Duty or Edge takes effect immediately instead, and
can be audible as a step.

### Entrainment

A carrier tone multiplied by a pulse envelope, identical in both ears.

- **Modulation**: 20–60 Hz in 0.5 Hz steps. This is the pulse rate, 40 Hz by default (a 25 ms
  period).
- **Carrier**: 80–1000 Hz. This is the tone's pitch. The readout shows the nearest note, and the
  hint below shows where the sidebands fall.
- **Envelope shape**: Sine, Raised cos or Square. These are shortcuts to particular Duty and Edge
  settings. Anything in between is labeled **custom**.
- **Duty**: 5–100%. The fraction of each period the pulse occupies.
- **Edge**: 0–100%. The cosine taper, as a fraction of the pulse width. At 0 the transition is
  hard and can be heard as clicks.
- **Depth**: 0–100%. How deep the modulation goes. At 0 the tone is unmodulated.
- **Entrainment level**: the level of this layer, shown in dB.

The **Tuning** box shows the carrier's note and how far it sits from that note. Use **−12**,
**−1**, **+1** and **+12** to move by semitones, **Snap** to land on the nearest note, or type a
frequency in Hz.

### Two-tone

Two tones, one at the carrier and one at the carrier plus the modulation rate. **Lower** and
**Upper** show their frequencies, and **Two-tone level** sets their level. **Routing** decides
what you hear:

- **Off**: the layer is silent.
- **Binaural**: one tone in each ear. The beat forms between the ears, so this needs headphones.
- **Monaural**: both tones in both ears. The beat is in the waveform itself, so it works on
  speakers.

For binaural routing, use wired stereo headphones and turn off spatial or "enhanced" audio
processing. Speakers, or anything else that combines the two channels, turn a binaural beat into
an ordinary monaural one. The app cannot detect when that happens.

### Soundscape

Synthesized noise under the tones.

- **Pink**, **Brown** or **White**: pink falls 3 dB per octave. Brown falls 6 dB per octave, so it
  sounds darker with less hiss. White is flat and bright.
- **Soundscape level**: the level of the noise, shown in dB.
- **Notch depth**: 0–18 dB. How deeply the noise is cut at the carrier and both sidebands.
- **Notch Q**: 1–20. Higher values cut narrower notches and leave more of the noise intact.

The **Tone/bed gain ratio** readout compares the level of the tone with the noise.

### Level

**Master** sets the overall output from 0 to 100%. Sample peaks are capped at 80% of full scale
(**Ceiling 80%**) whatever the Master and layer levels. When a combination would go past the
ceiling, the app turns the whole mix down instead of letting it clip.

This is a bound on the digital signal, not on loudness at your ears. Set that with your system
volume, starting low.

The badge beside the ceiling shows the sample rate in use. The app asks for 48 kHz; see
[Troubleshooting](#troubleshooting) if yours differs.

### Envelope and Spectrum

**Spectrum** shows the whole mix at the output on a logarithmic scale, with the carrier and both
sidebands marked.

**Envelope** shows the tone layers — entrainment and two-tone — before the noise bed is mixed in.
Vertical rules mark one modulation period. The readout in the corner estimates the modulation
index and the peak-to-trough depth in dB, and two things about it are worth knowing:

- It is measured from the two channels combined into one. A binaural recipe has little modulation
  in either ear by itself, but the two tones beat against each other once combined, so the readout
  can show deep modulation for a signal no single ear receives that way.
- It assumes the carrier sits well above the modulation rate. At mid-range carriers it is close;
  toward the bottom of the range it drifts, and a fully modulated signal on an 80 Hz carrier at
  40 Hz reads anywhere from 83% to 100%. The error runs in both directions, so it is not smoothed
  away.

Read it as a display of what the engine is producing, not as a measurement of what reaches you.

## Presets

The built-in presets:

- **Balanced pulse**: raised-cosine 40 Hz pulses over notched pink noise, between sine and square
  gating. The default.
- **Gentle AM**: sinusoidal 40 Hz AM over brown noise, which gives a carrier and two sidebands
  only. The smoothest envelope.
- **Subtle pulse**: lower-level 40 Hz pulses under notched pink noise. Less noticeable.
- **Monaural beat**: two tones 40 Hz apart, mixed into both ears. Works on speakers.
- **Binaural beat — headphones**: one tone per ear, 40 Hz apart. Needs headphones.
- **500 Hz AM reference**: sinusoidal 40 Hz AM on a 500 Hz carrier, with no noise bed.

Built-in presets cannot be changed or deleted. **Save as…** makes a named copy of one. Once one of
your own presets has changes, it shows **Modified** and **Save** updates it in place. **Delete**
removes one of your presets after you confirm. Presets store the whole recipe, including the
Master level, but not the session duration.

## Preview and sessions

**Preview** plays the current recipe for as long as you like. It is not timed and not recorded,
so it is the way to try changes.

A **session** is a timed run, recorded in History when it ends. You can start one in two ways:

- **From Studio**: pick a duration in the Session strip and press **Start session**. The session
  plays whatever Studio holds, including unsaved changes.
- **From the tray**: open the popover and choose a preset (your last few appear as shortcuts).
  Pick a duration and press **Start session**. This plays the preset as saved.

If Preview is running, a new session takes over from it.

### During a session

Sound ramps in over three seconds. The status then reads **Ramping in**, **Stabilizing — about
M:SS to go** and **Stabilized**. These labels only mark whether the session has passed five
minutes; the app measures nothing about the listener. Sessions of five minutes or less show
**Running** instead.

You can keep adjusting the recipe in Studio while a session plays. The record keeps the recipe the
session started with and the one it ended on, and marks the session **Edited**. These are the two
endpoints, not a timeline: a setting you change and then change back leaves no trace beyond the
**Edited** mark.

To end early, press **Stop session** in Studio or **End session** in the popover, choose **Stop
session** from the tray menu, or use the global shortcut. There is no pause. A session that runs to
the end fades out over a second and a half, timed to finish at the planned end.

Each record ends with one of three outcomes:

- **Completed**: the session ran its full duration.
- **Stopped**: you stopped it, including by quitting the app.
- **Interrupted**: the session was cut off. When the computer goes to sleep, the app closes the
  record at that moment. When the app crashes or the window reloads, the record is closed the next
  time the app opens, using the last progress saved, which is written every 20 seconds.

## History

The **History** tab lists sessions newest first. Each record shows:

- the start time and preset (**Deleted preset** if you have since removed it)
- the outcome, and **Edited** if the recipe changed during the session
- the integrity result: **Checks clear**, **Check warning**, **Check failed** or **Not checked**
- a summary of the recipe, and what changed during the session
- time played against the time planned

**Recall recipe** loads a session's recipe into Studio. For edited sessions, choose **Recall
start** or **Recall end** instead. Recall never starts playback, and it leaves a running session's
timer, duration and selected preset alone — but it applies the recipe the way ordinary editing
does, so if something is already playing, it changes what you are hearing.

You can delete a single record, or everything with **Delete all history**. History stays on this
computer.

## Signal integrity

The status line under the header summarizes what has been checked, for example "Currently
checked: engine and app output — clear · not checked: system mix and delivery". Click it to open
**Signal integrity**.

![The Signal integrity dialog during a session. The Engine section lists self-test results for each envelope shape, the AM spectrum, both routings, block independence and phase drift. The App output section compares measured envelope rate, modulation depth and interaural correlation with a reference render.](images/integrity-dialog-light.png)

Checks are grouped by how far along the audio path they reach:

- **Engine**: a self-test of the engine's own arithmetic, run at launch. It needs no audio device
  and plays nothing. It covers envelope rate and depth for each shape, AM sideband structure,
  binaural and monaural routing, block-to-block consistency, and phase drift.
- **App output**: measurements of real playback. The tone path is compared against a reference
  render of the same settings — envelope rate, modulation depth, interaural correlation, stereo
  difference, channel balance and sidebands — and the final output is checked for validity,
  continuous signal and headroom. The complete mix, bed and notches included, is not compared
  against a reference. These run once playback settles, again after each change, and whenever you
  press **Check app output now**.
- **System mix**: not checked. This would mean reading back the operating system's mix.
- **Delivery**: never checked, on any platform. Nothing in the app can observe your audio
  hardware, Bluetooth, spatial processing or headphones.

History keeps the worst result seen during each session.

## Settings

- **Appearance**: Light, Dark, or System, which follows your operating system.
- **Daily listening advisory**: remind you after 30 minutes to 4 hours of listening in a day, or
  never. The default is 2 hours. The total counts finished sessions only — Preview and the session
  currently running are not in it — and the reminder appears between sessions rather than during
  one. It is only a reminder; nothing stops or is disabled.
- **Between sessions**: suggest waiting 15, 30, 60 or 120 minutes after a session. Off by default.
- **Keep 40 Hz running in the tray when I close the window** (macOS and Windows): on by default.
  When it's off, closing the window quits the app, and a playing session is recorded first.
- **Start 40 Hz when I log in** (macOS and Windows): opens the app, and never starts a session.

**About**, at the bottom of Settings, shows the version and build.

## Tray and keyboard

How the tray works depends on the platform:

- **macOS**: click the menu bar icon for the popover, or right-click for the menu.
- **Windows**: click the icon for the popover, or right-click for the menu. New tray icons start
  hidden behind the **^** arrow in the taskbar.
- **Linux**: there is only the menu, where **Session…** opens the popover. Whether an icon appears
  at all depends on the desktop environment.

The tray menu has **Session…**, **Open Studio**, **Stop session** (or **Stop preview**) and **Quit
40 Hz**.

Keyboard shortcuts:

- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> on
  macOS), anywhere: stops what is playing. When nothing is playing, it opens the session popover.
  It never starts sound. Another application may already own this combination, in which case it
  does nothing at all.
- <kbd>Space</kbd>, in Studio: starts or stops Preview.
- <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>S</kbd> on macOS), in Studio: saves the current
  preset.

The Studio shortcuts are ignored while a text field or other control has focus, or while a dialog
is open.

## Your data

Presets, history and settings are stored as `presets.json`, `history.json` and `settings.json`
in a `fortyhz` folder:

- macOS: `~/Library/Application Support/fortyhz`
- Windows: `%APPDATA%\fortyhz`
- Linux: `~/.config/fortyhz`

Deleting that folder resets the app. To clear only the session log, use **Delete all history**.

## Troubleshooting

**I can't find the tray icon.** On Windows, look behind the **^** arrow in the taskbar. On Linux,
your desktop may not show tray icons; GNOME needs a StatusNotifierItem (AppIndicator) extension.
You can start and stop sessions from Studio either way.

**The AppImage won't start on Ubuntu 24.04 or later.** It needs FUSE 2, which recent releases no
longer install by default. Either install it (`sudo apt install libfuse2t64`), run the file as
`./<file>.AppImage --appimage-extract-and-run`, or use the `.deb` instead.

**Studio shows "Running at 44100 Hz, not the requested 48000 Hz".** The audio is still generated
correctly at either rate, but at 48 kHz the 25 ms modulation period lands on whole samples. To get
48 kHz, set your output device to it in your system's sound settings, then restart the app.

**A binaural beat sounds like an ordinary beat.** Something is combining the two channels, such as
speakers, a Bluetooth headset in hands-free mode, a system-wide mono audio setting, or spatial
audio. Use wired stereo headphones with spatial or enhanced processing turned off. The app cannot
detect this.

**The global shortcut does nothing.** Another application may already use that key combination.
Use the tray menu or Studio instead.

**macOS or Windows won't open the app.** The builds are not signed by a trusted publisher. See
[Install](../README.md#install) for the one-time step on each platform.
