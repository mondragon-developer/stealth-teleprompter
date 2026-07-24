# Screen Script

A teleprompter for presentations that is invisible to screen capture. The
window floats always-on-top on your monitor, but people watching your shared
screen in Zoom, Meet, Teams or OBS cannot see it.

Built with Tauri 2 (Rust + vanilla JS webview).

## How the invisibility works

The window is flagged with content protection, which on Windows maps to
SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE. Screen capture APIs
skip the window entirely, so it never appears in shared screens, recordings
or screenshots. It only defeats software capture: a projector fed by display
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

## Usage

Scripts are plain .txt or .md files. Open the Scripts panel, click Open
folder, and drop your files there, or use Paste new to paste a script
directly. The app remembers your reading position per script.

Auto-scroll runs at an adjustable speed. You can also scroll manually with
the mouse wheel, arrow keys, PageUp / PageDown, Home and End.

Ghost mode makes the window click-through so your mouse reaches the slides
underneath. Stealth toggles the capture invisibility if you ever want the
prompter to show up in a recording.

## Global hotkeys

These work while any application has focus:

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

Note: the window is hidden from the taskbar, so if you hide it with
Ctrl+Alt+H, the same hotkey is the way to bring it back.
