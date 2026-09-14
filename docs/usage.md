# Using 40 Hz Studio

For download and first launch, see the [README](../README.md#install). The installed app is named
**40 Hz**, and it has two surfaces:

- **Studio** — the main window, where you build and hear a sound recipe.
- **The tray popover** — a small panel for starting a session without opening Studio.

[Start here](#start-here) is enough to get going. The rest is reference:
[sound recipe](#the-sound-recipe) · [presets](#presets) · [sessions](#sessions) ·
[history](#history) · [signal integrity](#signal-integrity) · [settings](#settings) ·
[tray and keyboard](#tray-and-keyboard) · [your data](#your-data) ·
[troubleshooting](#troubleshooting)

## Start here

### Hear something

1. Open Studio. The preset picker in the header starts on **Balanced pulse**.
2. Press **Preview**.
3. Set the volume with your system's control, starting low.
4. Drag **Modulation** in the Entrainment column and listen to the pulse rate change. Nothing
   restarts.

### Preview or session

**Preview** plays the current recipe, untimed and unrecorded, so it is the way to try changes. A
**session** is a timed run, recorded in History when it ends; starting one takes over from Preview.

### Three ways to use it

- **Just listen.** Open the tray popover, pick a preset and a duration, and press **Start
  session**. Studio never has to open.
- **Build a sound.** Preview, adjust, **Save as…** a preset of your own, then start a session from
  Studio.
- **Go back to a past session.** In **History**, press **Recall recipe** (**Recall start** or
  **Recall end** if the session was edited), then press **Preview** or **Start session**.

## The sound recipe

![The Sound recipe panel. Entrainment has sliders for modulation, carrier, duty, edge, depth and level, an envelope-shape selector, and a tuner with semitone buttons. Two-tone has Off, Binaural and Monaural routing. Soundscape has noise color, level, notch depth and notch Q.](images/sound-recipe-light.png)

Three layers, mixed to one output. Changes apply to sound that is already playing, and most are
smoothed: the carrier glides to its new pitch, routing switches fade out and back in, and levels
ramp. Envelope shape, Duty and Edge change immediately instead, and the step can be audible.

### Entrainment: shape the pulse

A carrier tone multiplied by a pulse envelope, identical in both ears.

| Control               | What it changes                                    | Range                                                       |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| **Modulation**        | The pulse rate                                     | 20–60 Hz in 0.5 Hz steps; 40 Hz by default (a 25 ms period) |
| **Carrier**           | The tone's pitch                                   | 80–8000 Hz                                                  |
| **Envelope shape**    | Jumps to a named Duty and Edge pair                | Sine, Raised cos, Square; anything else shows **custom**    |
| **Duty**              | The fraction of each period the pulse occupies     | 5–100%                                                      |
| **Edge**              | The cosine taper, as a fraction of the pulse width | 0–100%                                                      |
| **Depth**             | How deep the modulation goes                       | 0–100%; at 0 the tone is unmodulated                        |
| **Entrainment level** | The level of this layer                            | In dB                                                       |

At an Edge of 0 the transition is hard and can be heard as clicks.

The carrier readout names the nearest note, and the hint below it gives the sideband frequencies.
In **Tuning**, **−12**, **−1**, **+1** and **+12** move by semitones, **Snap** lands on the nearest
note, and you can type a frequency in Hz.

### Two-tone: binaural and monaural beats

Two tones, one at the carrier and one at the carrier plus the modulation rate. **Lower** and
**Upper** show their frequencies, and **Two-tone level** sets their level. **Routing** decides what
you hear:

| Routing      | What you hear                | Where the beat forms                            |
| ------------ | ---------------------------- | ----------------------------------------------- |
| **Off**      | Nothing; the layer is silent | —                                               |
| **Binaural** | One tone in each ear         | Between the ears, so this needs headphones      |
| **Monaural** | Both tones in both ears      | In the waveform itself, so it works on speakers |

> [!WARNING]
> For binaural routing, use wired stereo headphones and turn off spatial or "enhanced" audio
> processing. Speakers, or anything else that combines the two channels, turn a binaural beat into
> an ordinary monaural one. The app cannot detect when that happens.

### Soundscape: the noise bed

| Control              | Range / choices                                |
| -------------------- | ---------------------------------------------- |
| **Colour**           | Pink, Brown, White                             |
| **Soundscape level** | In dB                                          |
| **Notch depth**      | 0–18 dB, cut at the carrier and both sidebands |
| **Notch Q**          | 1–20; higher is narrower                       |

Pink falls 3 dB per octave. Brown falls 6 dB per octave, so it sounds darker, with less hiss. White
is flat and bright. Narrower notches leave more of the noise intact. The **Tone/bed gain ratio**
readout compares the level of the tone with the noise.

### Level and the ceiling

**Master** sets the overall output from 0 to 100%. Sample peaks are capped at 80% of full scale
(**Ceiling 80%**) whatever the Master and layer levels. When a combination would go past the
ceiling, the app turns the whole mix down instead of letting it clip.

> [!WARNING]
> The ceiling is a bound on the digital signal, not on loudness at your ears. Set that with your
> system volume, starting low.

The badge beside the ceiling shows the sample rate in use. The app asks for 48 kHz; see
[Troubleshooting](#troubleshooting) if yours differs.

### Reading the Envelope and Spectrum charts

**Spectrum** shows the whole mix at the output on a logarithmic scale, with the carrier and both
sidebands marked.

**Envelope** shows the tone layers before the noise bed is mixed in, with vertical rules one
modulation period apart. Its corner readout estimates the modulation index and peak-to-trough depth
in dB, with two limits:

- It is measured from both channels combined. A binaural recipe has little modulation in either
  ear alone, so the readout can show deep modulation that no single ear receives.
- It assumes the carrier sits well above the modulation rate. Toward the bottom of the carrier
  range it drifts: a fully modulated 80 Hz carrier at 40 Hz reads anywhere from 83% to 100%. The
  error runs in both directions, so it is not smoothed away.

The readout shows what the engine is producing, not what reaches you.

## Presets

| Preset                         | Signal                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Balanced pulse**             | Raised-cosine 40 Hz pulses over notched pink noise, between sine and square gating. The default. |
| **Gentle AM**                  | Sinusoidal 40 Hz AM over brown noise: a carrier and two sidebands only. The smoothest envelope.  |
| **Subtle pulse**               | Lower-level 40 Hz pulses under notched pink noise. Less noticeable.                              |
| **Monaural beat**              | Two tones 40 Hz apart, mixed into both ears. Works on speakers.                                  |
| **Binaural beat — headphones** | One tone per ear, 40 Hz apart. Needs headphones.                                                 |
| **500 Hz AM reference**        | Sinusoidal 40 Hz AM on a 500 Hz carrier, with no noise bed.                                      |
| **GENUS inspired**             | Hard-gated 1.25 ms bursts of an 8 kHz tone, 40 a second, with no noise bed. Harsh.               |

Built-in presets cannot be changed or deleted; **Save as…** makes a named copy. Your own presets
show **Modified** once changed, **Save** updates them in place, and **Delete** asks before removing
one. A preset stores the whole recipe, including the Master level, but not the session duration.

## Sessions

### Starting one

- **From Studio** — pick a duration of 10, 20, 30, 45 or 60 minutes in the Session strip and press
  **Start session**. The session plays whatever Studio holds, including unsaved changes.
- **From the tray** — open the popover and choose a preset (your last few appear as shortcuts).
  Pick a duration and press **Start session**. This plays the preset as saved.

### While it runs

Sound ramps in over three seconds. The status then reads **Ramping in**, **Stabilizing — about
M:SS to go** and **Stabilized**. These labels only mark whether the session has passed five
minutes; the app measures nothing about the listener.

You can keep adjusting the recipe in Studio. The record keeps the recipe the session started with
and the one it ended on, and marks the session **Edited**. These are two endpoints, not a timeline:
a setting you change and then change back leaves no trace beyond the **Edited** mark.

### Ending one

Press **Stop session** in Studio or **End session** in the popover, choose **Stop session** from the
tray menu, or use the [global shortcut](#tray-and-keyboard). There is no pause. A session that runs
to the end fades out over a second and a half, timed to finish at the planned end.

| Outcome         | Means                                          |
| --------------- | ---------------------------------------------- |
| **Completed**   | The session ran its full duration.             |
| **Stopped**     | You stopped it, including by quitting the app. |
| **Interrupted** | The session was cut off.                       |

If the computer goes to sleep, the record is closed at that moment. If the app crashes or the window
reloads, it is closed the next time the app opens, using the last saved progress — which is written
every 20 seconds.

## History

The **History** tab lists sessions newest first. Each record shows:

- the start time and preset (**Deleted preset** if you have since removed it)
- the outcome, and **Edited** if the recipe changed during the session
- the integrity result: **Checks clear**, **Check warning**, **Check failed** or **Not checked**
- a summary of the recipe, and what changed during the session
- time played against the time planned

**Recall recipe** loads a session's recipe into Studio; for edited sessions, choose **Recall start**
or **Recall end**. Recall never starts playback, and it leaves a running session's timer, duration
and selected preset alone. But it applies the recipe the way ordinary editing does, so if something
is already playing, it changes what you hear.

You can delete a single record, or everything with **Delete all history**.

## Signal integrity

The status line under the header summarizes what has been checked, for example "Currently checked:
engine and app output — clear · not checked: system mix and delivery". Click it to open **Signal
integrity**.

![The Signal integrity dialog during a session. The Engine section lists self-test results for each envelope shape, the AM spectrum, both routings, block independence and phase drift. The App output section compares measured envelope rate, modulation depth and interaural correlation with a reference render.](images/integrity-dialog-light.png)

Checks are grouped by how far along the audio path they reach:

- **Engine** — a self-test of the engine's own arithmetic, run at launch. It needs no audio device
  and plays nothing. It covers envelope rate and depth for each shape, AM sideband structure,
  binaural and monaural routing, block-to-block consistency, and phase drift.
- **App output** — measurements of real playback. The tone path is compared against a reference
  render of the same settings: envelope rate, modulation depth, interaural correlation, stereo
  difference, channel balance and sidebands. The final output is checked for validity, continuous
  signal and headroom. The complete mix, bed and notches included, is not compared against a
  reference. These run once playback settles, after each change, and when you press **Check app
  output now**.
- **System mix** — not checked. This would mean reading back the operating system's mix.
- **Delivery** — never checked, on any platform. Nothing in the app can observe your audio
  hardware, Bluetooth, spatial processing or headphones.

History keeps the worst result seen during each session.

## Settings

| Setting                                                    | Choices                                             |
| ---------------------------------------------------------- | --------------------------------------------------- |
| **Appearance**                                             | Light, Dark or System; System by default            |
| **Daily listening advisory**                               | 30 minutes to 4 hours, or never; 2 hours by default |
| **Between sessions**                                       | 15, 30, 60 or 120 minutes; off by default           |
| **Keep 40 Hz running in the tray when I close the window** | On or off; on by default                            |
| **Start 40 Hz when I log in**                              | On or off; off by default                           |

The advisory and **Between sessions** are reminders; nothing stops or is disabled. The daily total
counts finished sessions only — not Preview, and not the session in progress — and the reminder
appears between sessions, never during one. Studio and the tray both show the time recorded from
today's sessions.

The last two settings exist on macOS and Windows only. Launch at login opens the app and never
starts a session. When the tray setting is off, and always on Linux, closing the Studio window
quits the app, and a playing session is recorded first.

**About**, at the bottom of Settings, shows the version and build.

## Tray and keyboard

The tray menu has **Session…**, **Open Studio**, **Stop session** (or **Stop preview**) and **Quit
40 Hz**.

| Platform    | How to reach it                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| **macOS**   | Click the menu bar icon for the popover, or right-click for the menu.                                         |
| **Windows** | Click the icon for the popover, or right-click for the menu.                                                  |
| **Linux**   | There is only the menu, where **Session…** opens the popover. Whether an icon appears depends on the desktop. |

| Shortcut                                                   | Where    | Does                                                                                     |
| ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> | Anywhere | Stops what is playing, or opens the session popover when nothing is. Never starts sound. |
| <kbd>Space</kbd>                                           | Studio   | Starts or stops Preview.                                                                 |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>S</kbd>                  | Studio   | Saves the current preset.                                                                |

The Studio shortcuts are ignored while a text field or other control has focus, or while a dialog
is open.

## Your data

Presets, history and settings are stored as `presets.json`, `history.json` and `settings.json` in a
`fortyhz` folder:

| Platform | Folder                                  |
| -------- | --------------------------------------- |
| macOS    | `~/Library/Application Support/fortyhz` |
| Windows  | `%APPDATA%\fortyhz`                     |
| Linux    | `~/.config/fortyhz`                     |

Deleting that folder resets the app. To clear only the session log, use **Delete all history**.

## Troubleshooting

**I can't find the tray icon.** On Windows, look behind the **^** arrow in the taskbar. On Linux,
your desktop may not show tray icons; GNOME needs a StatusNotifierItem (AppIndicator) extension.
You can start and stop sessions from Studio either way.

**The AppImage won't start on Ubuntu 24.04 or later.** It needs FUSE 2, which recent releases no
longer install by default. Install it (`sudo apt install libfuse2t64`), run the file as
`./<file>.AppImage --appimage-extract-and-run`, or use the `.deb` instead.

**Studio shows "Running at 44100 Hz, not the requested 48000 Hz".** The audio is still generated
correctly at either rate, but at 48 kHz the 25 ms modulation period lands on whole samples. To get
48 kHz, set your output device to it in your system's sound settings, then restart the app.

**A binaural beat sounds like an ordinary beat.** Something is combining the two channels: speakers,
a Bluetooth headset in hands-free mode, a system-wide mono setting, or spatial audio. The app cannot
detect this.

**The global shortcut does nothing.** Another application may already own that combination. Use
the tray menu or Studio instead.

**macOS or Windows won't open the app.** The builds are not signed by a trusted publisher. See
[Install](../README.md#install) for the one-time step on each platform.
