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

- [ ] Create the GitHub repo and push; confirm the build workflow goes
      green on both Windows and macOS
- [ ] Tag v0.1.0 and confirm the release workflow publishes both
      installers
- [ ] Verify invisibility against a real screen share (Zoom, Meet, Teams,
      OBS) from a second participant's view
- [ ] Rehearse a full presentation run: ghost mode over slides, speed
      changes mid-read
- [ ] Custom app icon (still the default Tauri icon; needed before the
      LinkedIn announcement)
- [ ] Smoke test the installed app from the CI installer, not just dev
- [ ] Record the split-screen demo clip for the LinkedIn post
- [ ] Possible: per-script speed override, countdown before auto-scroll
      starts, configurable hotkeys, tray icon, window position memory,
      elapsed / remaining time readout, auto-updater

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

One tooling lesson: two `tauri dev` instances at once fight over the built
exe and the second dies with "Access is denied"; run it from one place
only.

Confirmed working at session end.

### 2026-07-24, second session

Set up distribution and groundwork for what comes next. Two GitHub Actions
workflows: build.yml compiles the Windows installers (.exe and .msi) and a
universal macOS .dmg on every push and keeps them as 14-day artifacts;
release.yml runs on v* tags and publishes the same installers to a GitHub
release, with unsigned-binary instructions in the release notes. Neither
platform is code-signed yet.

Wrote IOS.md capturing everything a future iPhone port needs: what carries
over (the whole vanilla JS frontend, the Rust script/settings commands, the
mobile entry point and desktop-gated shortcut plugin already in place),
what has no iOS equivalent (global hotkeys, ghost mode, capture protection,
which the phone-as-second-device use case does not need anyway), and the
one cheap habit to keep: gate desktop-only features behind a platform
check in init().

Repo hygiene pass before going public: only source files are tracked,
local editor and tool state stay ignored, and
the git author uses the GitHub noreply address. Drafted LINKEDIN-POST.md
for the eventual announcement, including alternative hooks and posting
notes; the split-screen demo clip is the missing piece.
