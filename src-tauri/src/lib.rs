mod llm;
mod speech;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

struct ClickThrough(AtomicBool);

struct HotkeyStatus(Mutex<Vec<String>>);

struct HotkeyBindings(Mutex<HashMap<String, String>>);

struct HotkeyIds(Mutex<HashMap<u32, String>>);

// Keys are JS KeyboardEvent.code names so the frontend recorder and the
// global-shortcut parser round-trip the same strings.
const DEFAULT_HOTKEYS: &[(&str, &str)] = &[
    ("toggle-play", "ctrl+alt+Space"),
    ("speed-up", "ctrl+alt+ArrowUp"),
    ("speed-down", "ctrl+alt+ArrowDown"),
    ("jump-back", "ctrl+alt+ArrowLeft"),
    ("jump-forward", "ctrl+alt+ArrowRight"),
    ("restart", "ctrl+alt+Home"),
    ("toggle-visibility", "ctrl+alt+KeyH"),
    ("toggle-click-through", "ctrl+alt+KeyC"),
    ("toggle-voice", "ctrl+alt+KeyV"),
    ("answer", "ctrl+alt+KeyQ"),
];

#[derive(Serialize)]
struct ScriptInfo {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct HotkeyConfig {
    bindings: HashMap<String, String>,
    unavailable: Vec<String>,
}

const WELCOME_SCRIPT: &str = r#"# Welcome to Screen Script

This window is visible to you but invisible to screen capture. While Stealth
is on, Zoom, Meet, Teams and OBS viewers cannot see it, even when you share
your whole screen.

Press Play or Ctrl+Alt+Space to start the auto-scroll. Tune the speed with
the slider, or with Ctrl+Alt+Up and Ctrl+Alt+Down while you talk. The
steps get finer at the slow end, all the way down to zero. Words
highlights the word under the reading line as the text moves.

Prefer to set the pace with your voice? Click Voice (Ctrl+Alt+V) and
read aloud: the script follows you, and pauses when you stop. The speech
model runs on this computer; download it once from Keys.

## Answers

Click Answers to open a side panel that suggests replies when someone
asks you a question. Listen transcribes the meeting audio, and Answer
(Ctrl+Alt+Q) sends the question to the model you pick in Setup: LM Studio
on this computer, or Claude, ChatGPT or Kimi with your own API key.

## Adding your scripts

Open the Scripts panel and click Open folder. Drop your .txt or .md files
there and click Refresh. You can also click Paste new to paste a script
directly into the app.

Need a last-minute change? Click Edit and this or any script becomes
editable right on the prompter; Save writes it back to the file. The
Light button switches to a white theme if you prefer reading dark on
light.

## Hotkeys

These work even while another app has the keyboard focus, so you can drive
the prompter from inside PowerPoint or your browser.

Ctrl+Alt+Space plays or pauses. Ctrl+Alt+Up and Down change the speed.
Ctrl+Alt+Left and Right jump back and forward. Ctrl+Alt+Home goes back to
the top. Ctrl+Alt+H hides or shows this window. Ctrl+Alt+C toggles
click-through mode.

Those are only the defaults. Open Keys and click any combo to record your
own, for example if another program on your machine already owns one of
them.

Click-through mode lets your mouse pass straight through this window to the
slides underneath. While it is on you cannot click the controls, so press
the click-through hotkey again to get your mouse back. The hide/show hotkey
also restores your mouse when it shows the window.

The app remembers your reading position in every script.
"#;

fn scripts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("scripts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn assert_in_scripts_dir(app: &AppHandle, path: &Path) -> Result<(), String> {
    let dir = scripts_dir(app)?.canonicalize().map_err(|e| e.to_string())?;
    let target = path.canonicalize().map_err(|e| e.to_string())?;
    if target.starts_with(&dir) {
        Ok(())
    } else {
        Err("path is outside the scripts folder".into())
    }
}

#[cfg(desktop)]
fn toggle_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_visible().unwrap_or(true) {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_focus();
        // Failsafe escape from click-through, in case the ghost hotkey is
        // unavailable or was rebound while ghost mode was on.
        let ct = app.state::<ClickThrough>();
        if ct.0.swap(false, Ordering::SeqCst) {
            let _ = win.set_ignore_cursor_events(false);
            let _ = app.emit("click-through-changed", false);
        }
    }
}

#[tauri::command]
fn list_scripts(app: AppHandle) -> Result<Vec<ScriptInfo>, String> {
    let dir = scripts_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if path.is_file() && (ext == "txt" || ext == "md") {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("untitled")
                .to_string();
            out.push(ScriptInfo {
                name,
                path: path.to_string_lossy().to_string(),
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn read_script(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    assert_in_scripts_dir(&app, &p)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_script(app: AppHandle, name: String, content: String) -> Result<ScriptInfo, String> {
    let dir = scripts_dir(&app)?;
    let mut clean: String = name
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect::<String>()
        .trim()
        .to_string();
    if clean.is_empty() {
        clean = "untitled".into();
    }
    let mut path = dir.join(format!("{clean}.md"));
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = dir.join(format!("{clean}-{n}.md"));
    }
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(ScriptInfo {
        name: path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&clean)
            .to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn write_script(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    assert_in_scripts_dir(&app, &p)?;
    fs::write(&p, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_script(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    assert_in_scripts_dir(&app, &p)?;
    fs::remove_file(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({})))
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    let pretty = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, pretty).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_scripts_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = scripts_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_click_through(
    window: WebviewWindow,
    state: State<ClickThrough>,
    enabled: bool,
) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    state.0.store(enabled, Ordering::SeqCst);
    window
        .emit("click-through-changed", enabled)
        .map_err(|e| e.to_string())
}

// Desktop coordinates, so the frontend can tell the mouse is moving even
// while click-through keeps every mouse event away from the webview.
#[tauri::command]
fn cursor_position(app: AppHandle) -> Result<(f64, f64), String> {
    let p = app.cursor_position().map_err(|e| e.to_string())?;
    Ok((p.x, p.y))
}

#[tauri::command]
fn set_capture_protection(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_content_protected(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_hotkeys(bindings: State<HotkeyBindings>, status: State<HotkeyStatus>) -> HotkeyConfig {
    HotkeyConfig {
        bindings: bindings.0.lock().unwrap().clone(),
        unavailable: status.0.lock().unwrap().clone(),
    }
}

#[cfg(desktop)]
#[tauri::command]
fn set_hotkey(
    app: AppHandle,
    bindings: State<HotkeyBindings>,
    ids: State<HotkeyIds>,
    status: State<HotkeyStatus>,
    action: String,
    shortcut: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let sc_new: Shortcut = shortcut
        .parse()
        .map_err(|_| "not a valid key combination".to_string())?;
    let mut b = bindings.0.lock().unwrap();
    let old = b.get(&action).cloned().ok_or("unknown action")?;
    for (other, s) in b.iter() {
        if other != &action {
            if let Ok(sc) = s.parse::<Shortcut>() {
                if sc.id() == sc_new.id() {
                    return Err(format!("already used by {other}"));
                }
            }
        }
    }
    let mut st = status.0.lock().unwrap();
    let was_failed = st.contains(&action);
    let sc_old: Option<Shortcut> = old.parse().ok();
    if !was_failed {
        if let Some(o) = sc_old {
            let _ = app.global_shortcut().unregister(o);
        }
    }
    match app.global_shortcut().register(sc_new) {
        Ok(()) => {
            let mut m = ids.0.lock().unwrap();
            if let Some(o) = sc_old {
                m.remove(&o.id());
            }
            m.insert(sc_new.id(), action.clone());
            st.retain(|a| a != &action);
            b.insert(action, shortcut);
            Ok(())
        }
        Err(e) => {
            if !was_failed {
                if let Some(o) = sc_old {
                    let _ = app.global_shortcut().register(o);
                }
            }
            eprintln!("hotkey {shortcut} unavailable: {e}");
            Err("that combination is taken by another app".into())
        }
    }
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_hotkey(action: String, shortcut: String) -> Result<(), String> {
    let _ = (action, shortcut);
    Err("hotkeys are desktop only".into())
}

#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("no update available")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg(not(desktop))]
#[tauri::command]
async fn install_update() -> Result<(), String> {
    Err("updates are desktop only".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest is built without a bundled TLS provider (matching the updater
    // plugin), so one must be installed before the first HTTPS client.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // Registered before window creation so the saved position and size are
    // restored on launch. VISIBLE is excluded: quitting while hidden via the
    // hide/show hotkey must not produce an app that starts invisible.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::all()
                    .difference(tauri_plugin_window_state::StateFlags::VISIBLE),
            )
            .build(),
    );

    builder
        .manage(ClickThrough(AtomicBool::new(false)))
        .manage(HotkeyStatus(Mutex::new(Vec::new())))
        .manage(HotkeyBindings(Mutex::new(HashMap::new())))
        .manage(HotkeyIds(Mutex::new(HashMap::new())))
        .manage(speech::Speech::default())
        .setup(|app| {
            let dir = scripts_dir(app.handle())?;
            let has_scripts = fs::read_dir(&dir)
                .map(|mut it| it.next().is_some())
                .unwrap_or(false);
            if !has_scripts {
                let _ = fs::write(dir.join("welcome.md"), WELCOME_SCRIPT);
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Builder as ShortcutBuilder, GlobalShortcutExt, Shortcut, ShortcutState,
                };

                app.handle().plugin(
                    ShortcutBuilder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            let action = {
                                let ids = app.state::<HotkeyIds>();
                                let map = ids.0.lock().unwrap();
                                map.get(&shortcut.id()).cloned()
                            };
                            let Some(action) = action else { return };
                            match action.as_str() {
                                "toggle-visibility" => toggle_main_window(app),
                                "toggle-click-through" => {
                                    let state = app.state::<ClickThrough>();
                                    let enabled = !state.0.load(Ordering::SeqCst);
                                    state.0.store(enabled, Ordering::SeqCst);
                                    if let Some(win) = app.get_webview_window("main") {
                                        let _ = win.set_ignore_cursor_events(enabled);
                                    }
                                    let _ = app.emit("click-through-changed", enabled);
                                }
                                _ => {
                                    let _ = app.emit("hotkey", action);
                                }
                            }
                        })
                        .build(),
                )?;

                let mut bindings: Vec<(String, String)> = DEFAULT_HOTKEYS
                    .iter()
                    .map(|(a, s)| (a.to_string(), s.to_string()))
                    .collect();
                if let Ok(path) = settings_path(app.handle()) {
                    if let Ok(raw) = fs::read_to_string(&path) {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                            if let Some(map) = v.get("hotkeys").and_then(|h| h.as_object()) {
                                for (action, sc) in map {
                                    if let Some(s) = sc.as_str() {
                                        if s.parse::<Shortcut>().is_ok() {
                                            if let Some(entry) =
                                                bindings.iter_mut().find(|(a, _)| a == action)
                                            {
                                                entry.1 = s.to_string();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // A conflict with another app costs one hotkey, not the whole
                // launch (Ctrl+Alt+R and Ctrl+Alt+M were both taken on the
                // first test machine). Failures land in HotkeyStatus so the
                // frontend can flag them and offer rebinding.
                let mut failed = Vec::new();
                let mut ids = HashMap::new();
                for (action, s) in &bindings {
                    let Ok(sc) = s.parse::<Shortcut>() else {
                        failed.push(action.clone());
                        continue;
                    };
                    match app.global_shortcut().register(sc) {
                        Ok(()) => {
                            ids.insert(sc.id(), action.clone());
                        }
                        Err(e) => {
                            eprintln!("hotkey {s} unavailable: {e}");
                            failed.push(action.clone());
                        }
                    }
                }
                *app.state::<HotkeyStatus>().0.lock().unwrap() = failed;
                *app.state::<HotkeyIds>().0.lock().unwrap() = ids;
                *app.state::<HotkeyBindings>().0.lock().unwrap() = bindings.into_iter().collect();

                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;
                let toggle_item =
                    MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&toggle_item, &quit_item])?;
                TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .tooltip("Screen Script")
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "toggle" => toggle_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;

                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    let Ok(updater) = handle.updater() else { return };
                    if let Ok(Some(update)) = updater.check().await {
                        let _ = handle.emit("update-available", update.version.clone());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_scripts,
            read_script,
            save_script,
            write_script,
            delete_script,
            load_settings,
            save_settings,
            open_scripts_folder,
            set_click_through,
            cursor_position,
            set_capture_protection,
            get_hotkeys,
            set_hotkey,
            install_update,
            speech::speech_supported,
            speech::model_status,
            speech::download_model,
            speech::voice_context,
            speech::voice_start,
            speech::voice_stop,
            speech::listen_start,
            speech::listen_stop,
            speech::transcript_recent,
            speech::transcript_clear,
            llm::llm_set_key,
            llm::llm_has_key,
            llm::llm_models,
            llm::llm_loaded,
            llm::llm_answer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
