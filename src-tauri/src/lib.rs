mod easing;
mod panel;
mod store;

use serde_json::Value;
use std::path::PathBuf;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// Same file the app has always used, so the existing projects are not migrated
/// or moved. `TASKX_DATA` exists so tests never touch the real one.
fn data_path() -> PathBuf {
    if let Ok(path) = std::env::var("TASKX_DATA") {
        return PathBuf::from(path);
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("taskx").join("data.json")
}

#[tauri::command]
fn data_load() -> Value {
    store::load(&data_path())
}

#[tauri::command]
fn data_save(doc: Value) -> Result<(), String> {
    store::save(&data_path(), &doc)
}

#[tauri::command]
fn data_move(id: String, direction: String) -> Result<Value, String> {
    let path = data_path();
    let mut doc = store::load(&path);
    store::move_project(&mut doc, &id, &direction)?;
    store::save(&path, &doc)?;
    Ok(doc)
}

#[tauri::command]
fn panel_set_expanded(app: AppHandle, expanded: bool, instant: bool) {
    panel::set_by_user(&app, expanded, instant);
}

/// Pinned, or the user is typing: the watcher must not collapse on its own.
#[tauri::command]
fn panel_set_hold(app: AppHandle, hold: bool) {
    panel::set_hold(&app, hold);
}

#[tauri::command]
fn panel_set_reduced(app: AppHandle, reduced: bool) {
    panel::set_reduced(&app, reduced);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItemBuilder::with_id("toggle", "Show / hide TaskX").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&toggle, &quit]).build()?;

    TrayIconBuilder::with_id("taskx")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../../assets/tray.png"
        ))?)
        .tooltip("TaskX — Alt+X")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => panel::toggle(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                panel::toggle(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            panel::set_expanded(app, true, false);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(panel::Panel::default())
        .invoke_handler(tauri::generate_handler![
            data_load,
            data_save,
            data_move,
            panel_set_expanded,
            panel_set_hold,
            panel_set_reduced
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the panel window is declared in tauri.conf.json");

            let geometry = panel::measure(&window);
            window.set_size(tauri::LogicalSize::new(
                panel::COLLAPSED_W,
                geometry.height,
            ))?;
            window.set_position(tauri::LogicalPosition::new(geometry.x, geometry.y))?;
            panel::adopt(app.handle(), geometry);

            // Acrylic is the whole reason this is not a web page in a rectangle:
            // it frosts the actual desktop behind the panel.
            #[cfg(target_os = "windows")]
            {
                if let Err(err) = window_vibrancy::apply_acrylic(&window, Some((7, 17, 31, 176))) {
                    eprintln!("acrylic unavailable, falling back to a tinted panel: {err}");
                }
            }

            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let handle = app.handle().clone();
            // A taken key is not a crash: hover and the tray still reach the panel.
            if let Err(err) =
                app.global_shortcut()
                    .on_shortcut("Alt+X", move |_app, _shortcut, event| {
                        if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                            panel::toggle(&handle);
                        }
                    })
            {
                eprintln!("Alt+X is already registered by another app: {err}");
            }

            build_tray(app.handle())?;
            panel::start_pointer_watch(app.handle().clone());

            // Only when built for real: a dev binary must not register itself to
            // start at login.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TaskX");
}
