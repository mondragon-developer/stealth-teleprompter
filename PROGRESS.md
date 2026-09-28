# Progress

## Current state

v0.2.0 released and self-updating. The core loop is solid: load a script,
read it from the floating panel, auto-scroll at adjustable speed, drive
everything with global hotkeys while another app has focus. v0.3 work is
in the tree but not yet released: speed down to zero, word highlight,
voice follow and the Answers panel.

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
- Speed down to 0 px/s: quadratic slider, hotkey steps of 1 / 5 / 10 by
  band, time-left shows --:-- at 0 and h:mm:ss for long reads
- Word highlight: each word wrapped in a span, line layout cached and
  binary-searched per scroll frame, highlight sweeps the line at the focus
- Voice follow (Windows): cpal mic capture, whisper-rs on a 4 s sliding
  window primed with the upcoming script words, frontend fuzzy alignment
  in a window around the current word; models downloaded on demand
- Answers panel: WASAPI loopback transcription of the meeting audio,
  streamed suggestions from LM Studio, Claude, ChatGPT, Kimi or any
  OpenAI-compatible server; keys in the OS keychain

## Hotkeys

Ctrl+Alt+Space play/pause, Ctrl+Alt+Up/Down speed, Ctrl+Alt+Left/Right
jump, Ctrl+Alt+Home top, Ctrl+Alt+H hide/show, Ctrl+Alt+G click-through,
Ctrl+Alt+V voice follow, Ctrl+Alt+Q suggest answers.

## Next steps

- [x] Create the GitHub repo
      (https://github.com/mondragon-developer/stealth-teleprompter) and
      push
- [x] Confirm the build workflow goes green on both Windows and macOS
- [x] Add the updater signing secrets as repository secrets
- [x] Tag v0.1.0 and confirm the release workflow publishes both
      installers plus latest.json for the auto-updater
- [ ] Verify invisibility against a real screen share (Zoom, Meet, Teams,
      OBS) from a second participant's view
- [ ] Rehearse a full presentation run: ghost mode over slides, speed
      changes mid-read
- [ ] Smoke test the installed app from the CI installer, not just dev
- [ ] Confirm the installed v0.1.0 shows the Update button and updates
      itself to v0.2.0
- [ ] Record the split-screen demo clip for the LinkedIn post
- [ ] Read a full script aloud with Voice on (base model, then tiny and
      small) and tune the alignment thresholds in alignHeard if it lags
      or jumps
- [ ] Try Listen + Answer on a real call with LM Studio, then Claude;
      check the loopback picks up Zoom/Meet/Teams audio
- [ ] Confirm CI stays green with whisper.cpp in the Windows build
      (LIBCLANG_PATH step) and tag v0.3.0
- [ ] Possible: per-script speed override, mirror mode for beam-splitter
      glass, speech on macOS (mic via cpal works; loopback needs
      ScreenCaptureKit, and whisper.cpp must build for the universal
      target)

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

### 2026-07-24, third session

Hotkeys became configurable in the app. The Keys popover now lists every
action with its combo; clicking one records the next keypress, the backend
re-registers it live (rolling back if the new combo is taken), and the
binding persists in settings.json and is restored on launch. Failures show
in red with a rebind hint, so a conflict like the Ctrl+Alt+R one from the
first session is now a ten-second fix instead of a code change. A Reset
defaults button undoes experiments.

The rest of the v0.2 batch: real app icon generated from the dragon logo
(background lifted to transparency, all platform sizes including the
Android and iOS sets the port will want); a steel-blue palette matched to
the logo and checked against WCAG AA contrast on the panel color, plus
visible keyboard-focus outlines; estimated time-left readout in the
controls; optional 3-2-1 countdown before auto-scroll; a tray icon with
Show/Hide and Quit so the taskbar-hidden window can always be found;
window position and size restored across launches (visibility deliberately
excluded so quitting while hidden cannot produce an invisible start); and
an auto-updater that checks GitHub releases on launch and shows an Update
button in the title bar. Update artifacts are signed; the private key
lives outside the repo in ~/.tauri and CI reads it from repository
secrets. Release builds opt into updater artifacts via a config override
so plain pushes and local builds need no key.

Voice-follow scrolling stays on the roadmap as an optional mode: WebView2
ships no Web Speech API, so it needs a native speech engine and its own
session.

### 2026-07-24, fourth session

v0.1.0 shipped publicly: tagged, built by CI, and released with signed
update artifacts and latest.json, so the auto-updater has a live feed.
The release page carries the unsigned-installer first-run notes.

Two features landed after the release, queued for v0.2.0. A light theme:
the Light / Dark button switches palettes, both checked against WCAG AA on
the panel color, persisted like every other setting. And in-place editing:
Edit turns the stage into an editor for the loaded script, Save (or
Ctrl+Enter) writes straight back to the file through a new write_script
command with the same scripts-folder path guard, Esc cancels, and playback
controls stay locked while editing so a stray hotkey cannot scroll a
half-edited script.

Released both as v0.2.0. The tag is also the first live test of the
auto-updater: the installed v0.1.0 should discover it through latest.json
and update itself in place.

### 2026-07-24, fifth session

Release-day closeout. The repo went live at
github.com/mondragon-developer/stealth-teleprompter, both CI workflows
came back green on their first runs, the update-signing key moved into
repository secrets, and v0.1.0 published with all eight assets: the
Windows setup exe and msi, the universal macOS dmg, their signatures, and
latest.json for the update feed. The release notes carry the
unsigned-installer first-run instructions.

v0.2.0 followed the same day with the light theme and in-place editing.
Version bumped across tauri.conf.json, Cargo.toml and package.json, tag
pushed, release workflow publishing at session close. The installed
v0.1.0 becomes the auto-updater's first real user the next time it
launches after that build lands.

The launch post copy grew to match the product: rebindable hotkeys,
on-prompter editing in either theme, self-updating installs. Still ahead
of the announcement: the second-device screen-share proof and the
split-screen demo clip.

### 2026-09-28

Three requests from real use. The slowest speed (10 px/s) was still too
fast for some passages, so the floor is now 0 with a quadratic slider and
finer hotkey steps at the slow end. Reading along needed a clearer
anchor, so Words highlights the single word under the reading line. And
the biggest one: let the script follow the voice, and help with live
questions.

The plan went through a review before any code. It moved speech from
Vosk to whisper-rs (Vosk needs its DLL plus three MinGW runtime DLLs
shipped next to the exe and a fat dylib for the universal macOS build;
whisper.cpp links statically), kept the answer UI as a pane inside the
main window instead of a second window (Stealth, Ghost, hide and close
all act on the main window only), and flagged the word-highlight layout
thrash that the per-word rect reads would have caused.

Voice follow runs whisper on the last four seconds of mic audio, about
every quarter second while you speak (silence is skipped), primed with the script words
around the current position, and emits text that the frontend aligns
against a window of the script: the tail of what was heard is matched
backwards with a small edit-distance tolerance, forward moves are cheap,
backward jumps need a stronger match, and anything off script is
ignored. The answer panel transcribes the default output device through
WASAPI loopback, cut at pauses into phrases kept for three minutes in
memory only, and sends the last 90 seconds plus notes and script to the
chosen model. Two wire formats cover every provider: Anthropic's
Messages API for Claude (low effort for speed, server-side fallback on
Opus 5), and OpenAI chat completions for LM Studio, OpenAI, Kimi and
Ollama.

Build lesson: whisper-rs-sys ships pregenerated bindings for Linux only,
and on Windows they fail layout asserts, so bindgen has to run, which
needs libclang. CI points LIBCLANG_PATH at the runner's LLVM; locally,
install LLVM or set the variable. whisper.cpp is forced to opt-level 3
in dev builds, otherwise it cannot keep up with speech.
