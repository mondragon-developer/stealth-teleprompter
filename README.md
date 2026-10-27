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

`tauri dev` launches the app. `tauri build` creates the executable and installers;
it does not launch them. After a Windows build, run
`.\src-tauri\target\release\screen-script.exe` or open the generated installer.

On Windows the speech features compile whisper.cpp, whose Rust bindings
are generated with libclang. Install LLVM once (`winget install LLVM.LLVM`)
or point `LIBCLANG_PATH` at a folder containing `libclang.dll`.

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

Auto-scroll runs at an adjustable speed, from 0 up to 300 px/s. The slider
gives most of its travel to the slow end, and the speed hotkeys step by 1
below 20, by 5 up to 60 and by 10 above. You can also scroll manually with
the mouse wheel, arrow keys, PageUp / PageDown, Home and End. Words
highlights the single word under the reading line, sweeping across each
line at the scroll pace.

Voice (Windows) sets the pace from your voice instead: read aloud and the
highlight and the scroll follow what you say, holding still when you pause
or go off script. Recognition runs locally with a Whisper model downloaded
once from Keys > Speech recognition (tiny, base or small; English, Spanish
or auto-detect). Wheel or arrow-key scrolling while Voice is on re-anchors
it to wherever you land.

Answers opens a side panel for live questions. Listen (Windows) transcribes
the meeting audio playing on your computer, and Answer (or the hotkey)
sends the recent transcript, your notes and optionally the script to a
model, which streams back two or three short replies you could give. Setup
picks the provider: LM Studio running locally (start its server first),
Claude, ChatGPT, Kimi, or any other OpenAI-compatible server such as
Ollama. List loads the provider's models; API keys are stored in the
system keychain, never in the settings file. You can also type a question
instead of listening. Let people know when you transcribe them; answering
sends the transcript to the provider you chose.

Ghost mode makes the window click-through so your mouse reaches the slides
underneath. With Solid on, the background turns fully opaque (near black in
the dark theme, near white in the light one) after two seconds without mouse movement,
and goes back to the Opacity setting as soon as the mouse moves, so the
script is easy to read while you talk and the screen shows through while you
work on it. Stealth toggles the capture invisibility if you ever want the
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
| Ctrl+Alt+C | click-through on / off |
| Ctrl+Alt+V | voice follow on / off |
| Ctrl+Alt+Q | suggest answers |

The window is hidden from the taskbar, but the tray icon and the hide/show
hotkey can both bring it back. The window's position and size are restored
on the next launch.


## Reading and voice feedback

Paste new and Edit now offer **Bold** (Ctrl+B / Cmd+B) and **Title** buttons.
These insert Markdown, which is rendered while reading and preserved when saved.
A title on its own line no longer needs a blank line before the following paragraph.

Voice shows a live microphone level, whether audio is arriving, the most recent
recognized phrase, and the duration of the last recognition pass. Audio detected
means input is arriving, not necessarily that speech matched the script. Recognition
timing measures decoding only, not total microphone-to-highlight latency. A quiet
meter can mean silence, a muted mic, or the wrong Windows default input device.

New settings default to Whisper Tiny; existing model selections are preserved.
Choose Keys > Speech recognition > Tiny for a lighter reading setup, then choose
English or Spanish rather than Detect when the language is known. Tiny English is
also available and always recognizes English. Download sizes are not runtime RAM:
whisper.cpp lists roughly 273 MB memory for Tiny and 388 MB for Base. Faster results
still depend on hardware, accent, and input quality. Settings apply when capture
restarts. The reader checks for fresh speech more frequently and performs a final
recognition pass when speech pauses; it still uses chunked recognition.

[Vosk](https://alphacephei.com/vosk/) is a possible future streaming alternative;
its small English model is 40 MB and small models typically need about 300 MB RAM.
It is not integrated here. Benchmark recognition quality before replacing Whisper.
[Whisper resource reference](https://github.com/ggml-org/whisper.cpp)

## Claude and API consumption

For an Anthropic API key, open Answers > Setup > Use Claude Haiku 5.5, save your
key there, then use List to verify available models. Keys stay in the OS keychain.
Use **Delete saved key** in the same panel to remove the selected provider's
credential. The backend verifies that the keychain reports no entry before showing
"Deleted and verified". Storage errors do not count as proof of deletion; retry if
verification fails. Saving or deleting also clears the key input field. Deletion
does not revoke the key at the provider, remove clipboard copies, guarantee erasure
of process-memory remnants, or undo requests already sent. Revoke the key in the
provider's console if you want it disabled everywhere.
An existing provider/model choice is not changed until you choose another one.
Haiku is used for suggested answers; voice-follow recognition remains local.
Reading alone sends no Claude requests and consumes no API tokens.

The answer panel now shows Anthropic-reported input and output token counts for
the current request. Usage may be incomplete if a stream is interrupted. Other
providers may omit counts. This is not a billing ledger or an account balance.
Sending the full script adds input tokens on every answer; uncheck that option
when the notes and question provide enough context.

As checked on October 27, 2026, direct Claude API Haiku 5.5 pricing is $0.10 per
million input tokens and $0.50 per million output tokens for prompts up to 100,000
tokens. Above that threshold the rates are $0.50 and $2.50 respectively. An answer
with 2,000 input and 300 output tokens costs about $0.00035 at the lower tier;
1,000 such answers cost about $0.35, excluding extra features or provider-specific
charges. Use your provider's billing console for actual spending and limits.
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

Development checks: `npm test` and
`cargo check --manifest-path src-tauri/Cargo.toml`. Live microphone accuracy,
end-to-end latency, and account-specific Claude access require a local reading
session and an API request respectively; automated checks do not establish them.

Cloud provider presets send keys only to their official HTTPS API addresses.
Custom servers require HTTPS except for loopback addresses such as localhost;
API requests do not follow redirects. See [SECURITY.md](SECURITY.md) for storage
boundaries and the outstanding Linux-only dependency advisory.
