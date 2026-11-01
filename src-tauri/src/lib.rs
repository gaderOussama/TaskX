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

/// Windows paints a native caption over this window whenever it is activated,
/// even though the window is a popup with no caption bits and DWM reports no
/// frame. Forcing the frame and children to repaint drops it again.
#[cfg(target_os = "windows")]
fn drop_native_frame(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Gdi::{
        RedrawWindow, RDW_ALLCHILDREN, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };

    if let Ok(hwnd) = window.hwnd() {
        // SAFETY: hwnd is this app's window; a no-op frame change only makes
        // Windows recompute the non-client area and repaint it.
        unsafe {
            SetWindowPos(
                hwnd.0,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            RedrawWindow(
                hwnd.0,
                std::ptr::null(),
                std::ptr::null_mut(),
                RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn drop_native_frame(_: &tauri::WebviewWindow) {}

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
fn panel_set_mode(app: AppHandle, mode: String, instant: bool) {
    panel::set_by_user(&app, panel::Mode::parse(&mode), instant);
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
            panel::set_by_user(app, panel::Mode::Popover, false);
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
            panel_set_mode,
            panel_set_hold,
            panel_set_reduced
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the panel window is declared in tauri.conf.json");

            let geometry = panel::measure(&window);
            let (width, height, y) = panel::Mode::Circle.frame(&geometry);
            window.set_size(tauri::LogicalSize::new(width, height))?;
            window.set_position(tauri::LogicalPosition::new(geometry.x, y))?;
            panel::adopt(app.handle(), geometry);
            panel::clip_now(app.handle());

            // Acrylic is the whole reason this is not a web page in a rectangle:
            // it frosts the actual desktop behind the panel. It is switched on
            // when a card opens (see panel::set_mode) because Windows paints it
            // across the full rectangle, square corners and all.
            drop_native_frame(&window);
            let panel_window = window.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Focused(true) => {
                    let window = panel_window.clone();
                    std::thread::spawn(move || {
                        for delay in [25u64, 160] {
                            std::thread::sleep(std::time::Duration::from_millis(delay));
                            drop_native_frame(&window);
                        }
                    });
                }
                // Closing the panel hides it; the tray keeps the app alive.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = panel_window.hide();
                }
                _ => {}
            });

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
