mod easing;
mod panel;
mod store;

use serde_json::Value;
use std::path::PathBuf;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
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
fn panel_set_mode(app: AppHandle, mode: String, instant: bool) {
    panel::set_by_user(&app, panel::Mode::parse(&mode), instant);
}

/// Pinned, or the user is typing: the watcher must not collapse on its own.
#[tauri::command]
fn panel_set_hold(app: AppHandle, hold: bool) {
    panel::set_hold(&app, hold);
}

/// The card measured itself; Rust owns the window, so it does the resize.
#[tauri::command]
fn panel_set_card_height(app: AppHandle, height: f64) {
    panel::set_card_height(&app, height);
}

#[tauri::command]
fn panel_set_reduced(app: AppHandle, reduced: bool) {
    panel::set_reduced(&app, reduced);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItemBuilder::with_id("toggle", "Show / hide TaskX").build(app)?;
    use tauri_plugin_autostart::ManagerExt;
    let login = CheckMenuItemBuilder::with_id("login", "Start at login")
        .checked(app.autolaunch().is_enabled().unwrap_or(false))
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle, &login])
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("taskx")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../../assets/tray.png"
        ))?)
        .tooltip("TaskX — Alt+X")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle" => panel::toggle(app),
            // The check item flips itself on click; follow it.
            "login" => {
                let on = login.is_checked().unwrap_or(false);
                let _ = if on {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
            }
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
            panel_set_mode,
            panel_set_hold,
            panel_set_reduced,
            panel_set_card_height
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the panel window is declared in tauri.conf.json");

            let geometry = panel::measure(&window);
            let (width, height, x, y) = panel::Mode::Circle.frame(&geometry, panel::POPOVER_H);
            window.set_size(tauri::LogicalSize::new(width, height))?;
            window.set_position(tauri::LogicalPosition::new(x, y))?;
            panel::adopt(app.handle(), geometry);

            // A transparent window still gets a native caption painted over it
            // the first time Windows activates it. The caption lands a few
            // milliseconds after the focus event, so the repair trails it.
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

            // Only when built for real, and only on first run (no data file yet):
            // after that the tray's "Start at login" is the user's to keep off.
            // A dev binary must not register itself to start at login.
            #[cfg(not(debug_assertions))]
            if !data_path().exists() {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            build_tray(app.handle())?;
            panel::start_pointer_watch(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TaskX");
}
