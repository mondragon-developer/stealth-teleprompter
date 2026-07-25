# Screen Script

<img src="mdragon.png" alt="Screen Script logo" width="120" align="right" />

A teleprompter for presentations that is invisible to screen capture. The
window floats always-on-top on your monitor, but people watching your shared
screen in Zoom, Meet, Teams or OBS cannot see it.

Built with Tauri 2 (Rust + vanilla JS webview).

## How the invisibility works

The window is flagged with content protection, which on Windows maps to
SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE, and on macOS sets the
window's sharing type to none. Screen capture APIs skip the window
entirely, so it never appears in shared screens, recordings or
screenshots. It only defeats software capture: a projector fed by display
duplication or a phone camera pointed at the monitor will still show it.

## Running

```
npm install
npm run tauri dev
```

To build an installer:

```
npm run tauri build
```

## Download

GitHub Actions builds installers automatically. Every push to master builds
a Windows setup .exe and a universal macOS .dmg and keeps them for 14 days
as workflow artifacts. Pushing a version tag (v0.1.0, v0.2.0, ...) builds
the same installers and publishes them on the
[Releases page](https://github.com/mondragon-developer/stealth-teleprompter/releases).

The installers are not code-signed yet, so both systems warn on first run.
On Windows, click More info, then Run anyway in the SmartScreen dialog. On
macOS, clear the quarantine flag once after installing:

```
xattr -cr "/Applications/Screen Script.app"
```

## Usage

Scripts are plain .txt or .md files. Open the Scripts panel, click Open
folder, and drop your files there, or use Paste new to paste a script
directly. The app remembers your reading position per script.

Auto-scroll runs at an adjustable speed. You can also scroll manually with
the mouse wheel, arrow keys, PageUp / PageDown, Home and End.

Ghost mode makes the window click-through so your mouse reaches the slides
underneath. Stealth toggles the capture invisibility if you ever want the
prompter to show up in a recording.

Edit changes the loaded script in place: the stage becomes an editor,
Ctrl+Enter (or the Save button) writes it back to the file, Esc cancels.
The Light / Dark button switches between the dark theme and a white one;
both meet WCAG AA contrast.

The controls bar also shows the estimated reading time left at the current
speed, and the 3-2-1 button toggles a short countdown before auto-scroll
starts so you are never caught mid-breath.

The app checks GitHub for new releases on launch; when one exists an Update
button appears in the title bar and installs it in place.

## Global hotkeys

These work while any application has focus. All of them are editable: open
Keys, click a combo, and press the new keys. If another program already
owns a combo, the app keeps launching, marks that one key as taken, and
lets you rebind it.

Defaults:

| Keys | Action |
| --- | --- |
| Ctrl+Alt+Space | play / pause |
| Ctrl+Alt+Up | faster |
| Ctrl+Alt+Down | slower |
| Ctrl+Alt+Left | jump back |
| Ctrl+Alt+Right | jump forward |
| Ctrl+Alt+Home | back to top |
| Ctrl+Alt+H | hide / show window |
| Ctrl+Alt+G | click-through on / off |

The window is hidden from the taskbar, but the tray icon and the hide/show
hotkey can both bring it back. The window's position and size are restored
on the next launch.
