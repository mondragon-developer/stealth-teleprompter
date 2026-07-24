# Progress

## Current state

v0.1 working on Windows 11. The app builds and runs with `npm run tauri dev`
and the core loop is functional: load a script, read it from the floating
panel, auto-scroll at adjustable speed, drive everything with global hotkeys
while another app has focus.

## Done

- Tauri 2 scaffold, vanilla JS frontend, no bundler
- Capture-invisible window (contentProtected, WDA_EXCLUDEFROMCAPTURE),
  frameless, always-on-top, transparent, hidden from taskbar
- Script sources: .txt/.md files in the app-data scripts folder, plus
  paste-in (saved as .md); list, open, delete, open-folder
- Smooth continuous auto-scroll with speed 10-300 px/s, play/pause,
  auto-pause at end
- Manual control: mouse wheel, arrows, PageUp/Down, Home/End, Space
- Current-paragraph highlight at the focus line, edge fade masks
- Per-script reading position and all settings persisted
- Opacity slider, font size controls
- Ghost mode (click-through) with lockout protection: button disables if
  the escape hotkey cannot register, Ctrl+Alt+H also clears click-through
- Stealth toggle to re-enable capture visibility on demand
- Global hotkeys registered individually so a conflict costs one key, not
  the launch

## Hotkeys

Ctrl+Alt+Space play/pause, Ctrl+Alt+Up/Down speed, Ctrl+Alt+Left/Right
jump, Ctrl+Alt+Home top, Ctrl+Alt+H hide/show, Ctrl+Alt+G click-through.

## Next steps

- [ ] Verify invisibility against a real screen share (Zoom, Meet, Teams,
      OBS) from a second participant's view
- [ ] Rehearse a full presentation run: ghost mode over slides, speed
      changes mid-read
- [ ] Custom app icon (still the default Tauri icon)
- [ ] `npm run tauri build` release installer and a smoke test of the
      installed app
- [ ] Possible: per-script speed override, countdown before auto-scroll
      starts, configurable hotkeys

## Session log

### 2026-07-24

Planned the app and locked decisions: Tauri v2 over Electron, scripts from
files plus paste, smooth continuous auto-scroll. Scaffolded with
create-tauri-app (vanilla template), then replaced the template with the
real app: Rust backend (script CRUD, settings persistence, click-through,
capture protection, global shortcuts emitting events to the webview) and
the teleprompter frontend (auto-scroll loop, focus-line highlight, sidebar,
paste modal, help popover).

Two real-world hotkey conflicts surfaced on this machine and shaped the
design. Ctrl+Alt+R was already registered system-wide, which crashed the
first launch because the plugin registers shortcuts all-or-nothing; switched
to individual registration that logs and skips conflicts, and moved back-to-
top to Ctrl+Alt+Home. Then the launch log showed Ctrl+Alt+M (the click-
through escape) was also taken, which would have locked the user out of the
window; moved it to Ctrl+Alt+G, made the Ghost button self-disable when its
hotkey is unavailable, and made Ctrl+Alt+H clear click-through as a
failsafe.

One tooling lesson: a background `tauri dev` instance held a lock on the
built exe and broke the user's own `tauri dev` with "Access is denied"; the
dev instance should be run from one place only.

Confirmed working by the user at session end.
