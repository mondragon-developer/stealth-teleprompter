use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

struct ClickThrough(AtomicBool);

struct HotkeyStatus(Mutex<Vec<String>>);

#[derive(Serialize)]
struct ScriptInfo {
    name: String,
    path: String,
}

const WELCOME_SCRIPT: &str = r#"# Welcome to Screen Script

This window is visible to you but invisible to screen capture. While Stealth
is on, Zoom, Meet, Teams and OBS viewers cannot see it, even when you share
your whole screen.

Press Play or Ctrl+Alt+Space to start the auto-scroll. Tune the speed with
the slider, or with Ctrl+Alt+Up and Ctrl+Alt+Down while you talk.

## Adding your scripts

Open the Scripts panel and click Open folder. Drop your .txt or .md files
there and click Refresh. You can also click Paste new to paste a script
directly into the app.

## Hotkeys

These work even while another app has the keyboard focus, so you can drive
the prompter from inside PowerPoint or your browser.

Ctrl+Alt+Space plays or pauses. Ctrl+Alt+Up and Down change the speed.
Ctrl+Alt+Left and Right jump back and forward. Ctrl+Alt+Home goes back to
the top. Ctrl+Alt+H hides or shows this window. Ctrl+Alt+G toggles
click-through mode.

Click-through mode lets your mouse pass straight through this window to the
slides underneath. While it is on you cannot click the controls, so press
Ctrl+Alt+G again to get your mouse back. Ctrl+Alt+H also restores your
mouse when it shows the window.

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

#[tauri::command]
fn get_unavailable_hotkeys(state: State<HotkeyStatus>) -> Vec<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn set_capture_protection(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_content_protected(enabled)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ClickThrough(AtomicBool::new(false)))
        .manage(HotkeyStatus(Mutex::new(Vec::new())))
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
                    Builder as ShortcutBuilder, Code, Modifiers, Shortcut, ShortcutState,
                };

                let mods = Modifiers::CONTROL | Modifiers::ALT;
                let play = Shortcut::new(Some(mods), Code::Space);
                let faster = Shortcut::new(Some(mods), Code::ArrowUp);
                let slower = Shortcut::new(Some(mods), Code::ArrowDown);
                let back = Shortcut::new(Some(mods), Code::ArrowLeft);
                let forward = Shortcut::new(Some(mods), Code::ArrowRight);
                let top = Shortcut::new(Some(mods), Code::Home);
                let visibility = Shortcut::new(Some(mods), Code::KeyH);
                let ghost = Shortcut::new(Some(mods), Code::KeyG);

                app.handle().plugin(
                    ShortcutBuilder::new()
                        .with_handler(move |app, shortcut, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            if shortcut == &visibility {
                                if let Some(win) = app.get_webview_window("main") {
                                    if win.is_visible().unwrap_or(true) {
                                        let _ = win.hide();
                                    } else {
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                        // Failsafe escape from click-through, in
                                        // case the ghost hotkey is unavailable.
                                        let ct = app.state::<ClickThrough>();
                                        if ct.0.swap(false, Ordering::SeqCst) {
                                            let _ = win.set_ignore_cursor_events(false);
                                            let _ = app.emit("click-through-changed", false);
                                        }
                                    }
                                }
                                return;
                            }
                            if shortcut == &ghost {
                                let state = app.state::<ClickThrough>();
                                let enabled = !state.0.load(Ordering::SeqCst);
                                state.0.store(enabled, Ordering::SeqCst);
                                if let Some(win) = app.get_webview_window("main") {
                                    let _ = win.set_ignore_cursor_events(enabled);
                                }
                                let _ = app.emit("click-through-changed", enabled);
                                return;
                            }
                            let action = if shortcut == &play {
                                "toggle-play"
                            } else if shortcut == &faster {
                                "speed-up"
                            } else if shortcut == &slower {
                                "speed-down"
                            } else if shortcut == &back {
                                "jump-back"
                            } else if shortcut == &forward {
                                "jump-forward"
                            } else if shortcut == &top {
                                "restart"
                            } else {
                                return;
                            };
                            let _ = app.emit("hotkey", action);
                        })
                        .build(),
                )?;

                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                // Another app can own any of these combos; a conflict should
                // cost one hotkey, not the whole launch (Ctrl+Alt+R and
                // Ctrl+Alt+M were both taken on the first test machine). The
                // frontend reads the failures to disable dependent features.
                let entries = [
                    (play, "toggle-play"),
                    (faster, "speed-up"),
                    (slower, "speed-down"),
                    (back, "jump-back"),
                    (forward, "jump-forward"),
                    (top, "restart"),
                    (visibility, "toggle-visibility"),
                    (ghost, "toggle-click-through"),
                ];
                let mut failed = Vec::new();
                for (sc, action) in entries {
                    if let Err(e) = app.global_shortcut().register(sc) {
                        eprintln!("hotkey {sc:?} unavailable: {e}");
                        failed.push(action.to_string());
                    }
                }
                *app.state::<HotkeyStatus>().0.lock().unwrap() = failed;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_scripts,
            read_script,
            save_script,
            delete_script,
            load_settings,
            save_settings,
            open_scripts_folder,
            set_click_through,
            set_capture_protection,
            get_unavailable_hotkeys
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
