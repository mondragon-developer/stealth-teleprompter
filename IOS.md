# iOS notes

Notes for turning Screen Script into an iPhone app later. The desktop app
was built with that port in mind; this file records what carries over, what
cannot, and the decisions worth making early so the port stays cheap.

## How the port works

Tauri 2 ships iOS support: `npm run tauri ios init` scaffolds the Xcode
project, then `tauri ios dev` and `tauri ios build` run and package it.
Hard requirements: a Mac with Xcode (iOS builds cannot run on Windows or on
a Windows-hosted CI job; GitHub's macOS runners can do it), and an Apple
Developer account for installing on a real device or shipping to the App
Store. The bundle identifier `com.jmond.screenscript` is already set in
tauri.conf.json and can be reused as the App Store identifier.

## What the iPhone version actually is

On desktop the whole point is capture invisibility on the same machine that
is sharing its screen. On a phone the use case flips: the phone sits next
to the laptop as a physical teleprompter, invisible to the shared screen
because it was never part of it. So the headline feature is not needed and
not possible: `set_content_protected` is desktop-only in Tauri, and iOS has
no clean equivalent anyway (UIScreen.isCaptured only detects capture, it
does not prevent it). The iPhone app is simply a great pocket teleprompter
that shares its scripts and reading engine with the desktop app.

## What carries over unchanged

- The entire frontend. It is vanilla JS/CSS with no bundler and no
  framework, so the scroll engine, markdown-lite renderer, focus-line
  highlight, settings shape and per-script positions all run as-is in the
  iOS webview.
- The Rust script and settings commands. They resolve paths through
  `app.path()`, which maps to the app sandbox on iOS.
- `run()` already carries `#[cfg_attr(mobile, tauri::mobile_entry_point)]`,
  and the global-shortcut plugin is desktop-gated both in Cargo.toml
  (target cfg dependency) and in lib.rs (`#[cfg(desktop)]` setup block), so
  the crate compiles for iOS today without changes.

## What does not exist on iOS

- Global hotkeys. Phones have no system-wide shortcuts. Replace with
  on-screen touch controls; the existing keydown handler already covers
  Bluetooth keyboards inside the app.
- Ghost click-through mode, always-on-top, frameless dragging, skipTaskbar,
  hide/show window. All desktop window concepts; the related buttons and
  banners should not render on mobile.
- The opener plugin's "Open folder". There is no user-visible folder;
  script import needs the Files app / document picker or the share sheet.
  Paste-in already works everywhere.

## Frontend changes to plan

main.js currently assumes desktop unconditionally: it invokes
`set_click_through`, `set_capture_protection`, `get_hotkeys` and
`set_hotkey`, and listens for `hotkey` and `update-available` events.
Before the port, add one platform check early in `init()`
(tauri-plugin-os, or a one-line `is_mobile` command in Rust) and gate the
Ghost and Stealth buttons, the Keys popover, the hotkey listener, the
update button and the stealth-state label behind it. Keeping every future
desktop-only feature behind that same check is the single cheapest habit
for the port. The Rust side is already gated: global shortcuts, the tray
icon, window-state restore and the updater all sit inside `#[cfg(desktop)]`
with desktop-only dependencies, while the editor, themes, countdown and
time-left readout are plain webview code that ports as-is.

## iOS-specific work the desktop app never needed

- Keep the screen awake while a script is open (iOS idle timer / wake
  lock), or the phone sleeps mid-presentation.
- Safe-area insets (`env(safe-area-inset-*)`) and larger touch targets;
  the current 11-13px controls are mouse-sized.
- A portrait-first layout; the desktop layout is a wide strip.
- Script sync between desktop and phone (iCloud Drive folder, or paste via
  the share sheet). This is the feature that makes the two apps one
  product.

## Cheap validation before the port

src/ is a plain static web page. Serving it on the local network and
opening it in iPhone Safari tests the reading experience with zero native
work; only the `invoke()` calls need stubbing. A day of that will settle
the layout and touch-control questions before any Xcode time is spent.
