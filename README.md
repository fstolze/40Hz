# 40 Hz Studio

40 Hz Studio is a desktop app that synthesizes 40 Hz amplitude-modulated sound in real time. A
recording is fixed when it is made; here the pitch of the tone, the shape of each pulse, how deep
the modulation goes and what plays underneath are all live controls. Build the signal from pulsed
tones, binaural or monaural beats and a noise bed, watch its envelope and spectrum as it plays,
and run it as a timed session from the menu bar or system tray.

**[Download for macOS, Windows or Linux](https://github.com/fstolze/40Hz/releases)** — or
[build it from source](docs/building.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
  <img src="docs/images/home-light.png" alt="40 Hz Studio with a session running. A live envelope scope shows 40 Hz pulses, the spectrum marks the 220 Hz carrier and its 180 Hz and 260 Hz sidebands, and below them are the session countdown and the three-layer sound recipe.">
</picture>

## Shape the signal

A **sound recipe** has three layers, mixed to one output:

- **Entrainment** — a carrier tone shaped by a pulse envelope. Modulation runs from 20 to 60 Hz,
  40 Hz by default. The carrier runs from 80 to 1000 Hz, with a tuner that names the note, moves
  by semitones and snaps. Sine, Raised cos and Square are named points on one pulse-envelope
  family, and Duty, Edge and Depth move freely between them.
- **Two-tone** — a pair of tones separated by the modulation rate. **Binaural** routing puts one
  tone in each ear and needs headphones. **Monaural** routing puts both tones in both ears and
  works on speakers.
- **Soundscape** — pink, brown or white noise, notched at the carrier and both sidebands so the
  tone keeps its own space. Notch depth and width are adjustable.

Every control is live: changes apply to sound that is already playing, without restarting it.
**Preview** plays the current recipe untimed and records nothing, so it is the way to try an idea.

![The Sound recipe panel. Entrainment has sliders for modulation, carrier, duty, edge, depth and level, an envelope-shape selector, and a tuner with semitone buttons. Two-tone has Off, Binaural and Monaural routing. Soundscape has noise color, level, notch depth and notch Q.](docs/images/sound-recipe-light.png)

Six built-in presets give you starting points, each described by its signal rather than a promised
effect: **Balanced pulse** (the default), **Gentle AM**, **Subtle pulse**, **Monaural beat**,
**Binaural beat — headphones** and **500 Hz AM reference**. **Save as…** keeps your own version.

## Run it as a session

Pick a duration of 10, 20, 30, 45 or 60 minutes and press **Start session**. Starting from Studio
runs whatever Studio currently holds, unsaved edits included; starting from the tray runs a saved
preset without opening Studio at all.

<img src="docs/images/popover-light.png" width="380" alt="The tray popover during a session: a 25:01 countdown, the session status, an End session button, and today's listening time.">

- Sound ramps in over three seconds and fades out to finish on time. There is no pause.
- On macOS and Windows, closing the Studio window leaves the session playing, unless you turn that
  off in Settings. On Linux, closing quits the app and records the session first.
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> on
  macOS) stops playback from anywhere, and opens the session picker when nothing is playing.
  Nothing ever plays unless you start it, including when the app launches at login.
- The status reads **Ramping in**, **Stabilizing** and **Stabilized**. These mark whether the
  session has passed five minutes on the clock; the app measures nothing about the listener.
- **History** records each session: the preset, time played against the plan, whether it completed
  or was stopped, and the recipe it started and ended on, marked **Edited** if you changed it on
  the way. You can load a past recipe back into Studio, or delete one record or all of them.
- Studio and the tray both show the time recorded from today's sessions. An optional daily
  reminder tells you between sessions when that total passes a figure you set. It never stops
  playback.

## What it checks, and what it cannot

At launch the audio engine runs a self-test on its own arithmetic: envelope rate and depth for
each shape, sideband structure, both routings, and phase drift. During playback it measures its
tone path against a reference render, and checks its final output for validity, continuity and
headroom. Those checks run when playback settles, again after each change, and on demand. A status
line under the header carries the result, and **Signal integrity** lists the numbers.

Nothing checks the operating system's mixer, Bluetooth, your headphones or the air. A clear result
describes the audio the app produced, not what reached your ears.

## Private and local

Audio is synthesized on your machine. Presets, history and settings are files on your computer,
and you can delete them whenever you like. There is no account, no telemetry, and nothing is sent
anywhere.

## Install

Download the file for your system from
[Releases](https://github.com/fstolze/40Hz/releases). The supported systems are macOS 26,
Windows 11 and Ubuntu 24.04 or later. The app installs as **40 Hz**.

Builds are not signed by a trusted publisher, so the first launch needs one extra step:

- **macOS** — open the `.dmg` (`arm64` for Apple silicon, `x64` for Intel) and drag 40 Hz to
  Applications. When the first launch is blocked, go to **System Settings → Privacy & Security**
  and choose **Open Anyway**. Alternatively, run
  `xattr -dr com.apple.quarantine "/Applications/40 Hz.app"` in Terminal.
- **Windows** — run the `.exe` installer (x64). It installs for your user and asks no
  administrator prompt, and you can choose the folder. When SmartScreen shows "Windows protected
  your PC", choose **More info**, then **Run anyway**. The tray icon starts hidden behind the
  **^** arrow in the taskbar.
- **Linux** — on Debian or Ubuntu, install the `.deb` with `sudo apt install ./<file>.deb`. The
  `.AppImage` runs without installing once you make it executable (`chmod +x`), though it may
  need FUSE 2 on the newest distributions. Both are x64. Whether a tray icon appears depends on
  your desktop; GNOME needs a StatusNotifierItem (AppIndicator) extension.

## Intended use

40 Hz Studio is for listening during focused work, and for people who want to experiment with
auditory entrainment. It is not a medical device, and it is not intended to diagnose, treat, cure
or prevent any condition. Whether any of these signals helps concentration has not been
established.

Start at a comfortable volume and set it with your own system's control. Sessions ramp in rather
than starting at full level, and output peaks are capped at 80% of full scale whatever the Master
setting — a limit on the digital signal, which cannot know how loud your headphones make it.

## Documentation

- [Using 40 Hz Studio](docs/usage.md) — every control, sessions and history, settings, keyboard
  shortcuts and troubleshooting
- [Building from source](docs/building.md)

## License

[PolyForm Noncommercial 1.0.0](LICENSE). You may use, modify and share 40 Hz Studio for
noncommercial purposes.
