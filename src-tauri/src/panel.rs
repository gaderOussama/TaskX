use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewWindow};

use crate::easing::make_ease;

pub const COLLAPSED_W: f64 = 18.0;
pub const EXPANDED_W: f64 = 400.0;
const EXPAND_MS: u64 = 340;
const COLLAPSE_MS: u64 = 280;
const FRAME_MS: u64 = 16;
const POINTER_MS: u64 = 20;
const HOVER_INTENT_MS: u64 = 80;
const LEAVE_DELAY_MS: u64 = 450;
const LEFT_MARGIN: f64 = 0.0;
const HEIGHT_RATIO: f64 = 0.92;

#[derive(Clone, Copy)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub height: f64,
    pub scale: f64,
}

struct Inner {
    width: f64,
    expanded: bool,
    geometry: Geometry,
}

/// The panel's single source of truth. Everything the pointer watcher needs is
/// kept here so it never has to ask the main thread anything: a main thread busy
/// resizing the window answers late, and a late answer is how a collapse that
/// should have reversed carries on to the end.
pub struct Panel {
    inner: Mutex<Inner>,
    generation: AtomicU64,
    hold: AtomicBool,
    reduced: AtomicBool,
    /// An explicit close must survive the pointer still resting on the panel.
    suppress_hover: AtomicBool,
    /// Summoned by hotkey or tray while the pointer is elsewhere: stay open
    /// until the pointer has actually visited, or the leave rule re-closes it
    /// before it can be used.
    awaiting_pointer: AtomicBool,
}

impl Default for Panel {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                width: COLLAPSED_W,
                expanded: false,
                geometry: Geometry {
                    x: 0.0,
                    y: 0.0,
                    height: 660.0,
                    scale: 1.0,
                },
            }),
            generation: AtomicU64::new(0),
            hold: AtomicBool::new(false),
            reduced: AtomicBool::new(false),
            suppress_hover: AtomicBool::new(false),
            awaiting_pointer: AtomicBool::new(false),
        }
    }
}

/// Measured once at startup; afterwards the panel moves on its own and never
/// re-queries the display.
pub fn measure(window: &WebviewWindow) -> Geometry {
    let scale = window.scale_factor().unwrap_or(1.0);
    let area = window.current_monitor().ok().flatten().map(|monitor| {
        let area = monitor.work_area();
        (
            area.position.x as f64 / scale,
            area.position.y as f64 / scale,
            area.size.height as f64 / scale,
        )
    });
    let (ax, ay, ah) = area.unwrap_or((0.0, 0.0, 1080.0));

    let height = (ah * HEIGHT_RATIO).round();
    Geometry {
        x: ax + LEFT_MARGIN,
        y: ay + ((ah - height) / 2.0).round(),
        height,
        scale,
    }
}

pub fn adopt(app: &AppHandle, geometry: Geometry) {
    app.state::<Panel>().inner.lock().unwrap().geometry = geometry;
}

pub fn set_hold(app: &AppHandle, hold: bool) {
    app.state::<Panel>().hold.store(hold, Ordering::SeqCst);
}

pub fn set_reduced(app: &AppHandle, reduced: bool) {
    app.state::<Panel>().reduced.store(reduced, Ordering::SeqCst);
}

/// Acrylic covers the whole native rectangle, so the corners the CSS rounds
/// away still showed a faint square. Clipping the window to the same shape
/// removes it, and makes the rounding real for the pointer as well.
#[cfg(target_os = "windows")]
fn clip_to_round(window: &WebviewWindow, width: f64, height: f64, scale: f64) {
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;
    // CSS clamps a radius wider than the box, so the strip ends in half-pills.
    let r = (width.min(20.0) * scale).round() as i32;
    // The region starts at -r so the left arcs fall outside the window: square
    // against the screen edge, rounded where it meets the desktop.
    // SAFETY: the region is created here and handed to the window, which owns
    // it from that moment on.
    unsafe {
        let region = CreateRoundRectRgn(-r, 0, w + 1, h + 1, r * 2, r * 2);
        if !region.is_null() {
            SetWindowRgn(hwnd.0, region, 1);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn clip_to_round(_: &WebviewWindow, _: f64, _: f64, _: f64) {}

pub fn clip_now(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let state = app.state::<Panel>();
        let inner = state.inner.lock().unwrap();
        clip_to_round(&window, inner.width, inner.geometry.height, inner.geometry.scale);
    }
}

pub fn toggle(app: &AppHandle) {
    let (expanded, reduced) = {
        let state = app.state::<Panel>();
        let expanded = state.inner.lock().unwrap().expanded;
        (expanded, state.reduced.load(Ordering::SeqCst))
    };
    set_by_user(app, !expanded, reduced);
}

/// Closing on purpose: the pointer may still be sitting on the panel, and it
/// must not count as a reason to open again until it has left and come back.
pub fn set_by_user(app: &AppHandle, expanded: bool, instant: bool) {
    let state = app.state::<Panel>();
    if expanded {
        state.awaiting_pointer.store(true, Ordering::SeqCst);
    } else {
        state.suppress_hover.store(true, Ordering::SeqCst);
    }
    set_expanded(app, expanded, instant);
}

pub fn set_expanded(app: &AppHandle, expanded: bool, instant: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<Panel>();

    // Any new request invalidates the run in flight; the running frame notices
    // and stops, so the panel never fights itself.
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let (from, to, height, scale) = {
        let mut inner = state.inner.lock().unwrap();
        inner.expanded = expanded;
        (
            inner.width,
            if expanded { EXPANDED_W } else { COLLAPSED_W },
            inner.geometry.height,
            inner.geometry.scale,
        )
    };

    // Told before the surface moves: the renderer's content fade belongs to the
    // same movement, not to a later round trip.
    let _ = app.emit("panel:state", expanded);

    if instant || (to - from).abs() < 0.5 {
        state.inner.lock().unwrap().width = to;
        let _ = window.set_size(LogicalSize::new(to, height));
        clip_to_round(&window, to, height, scale);
        return;
    }

    let app = app.clone();
    thread::spawn(move || {
        let duration = Duration::from_millis(if expanded { EXPAND_MS } else { COLLAPSE_MS });
        let ease = if expanded {
            make_ease(0.22, 1.0, 0.36, 1.0)
        } else {
            make_ease(0.4, 0.0, 1.0, 1.0)
        };
        let start = Instant::now();

        loop {
            thread::sleep(Duration::from_millis(FRAME_MS));

            let state = app.state::<Panel>();
            if state.generation.load(Ordering::SeqCst) != generation {
                return;
            }

            let progress = (start.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
            let width = from + (to - from) * ease(progress);
            state.inner.lock().unwrap().width = width;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_size(LogicalSize::new(width, height));
                clip_to_round(&window, width, height, scale);
            }
            if progress >= 1.0 {
                break;
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn cursor_position() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: GetCursorPos only writes to the POINT we hand it.
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

#[cfg(not(target_os = "windows"))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

/// The webview's own hover events are not trustworthy here: a window that
/// resizes under a stationary cursor reports entry late, so a collapse that
/// should have reversed runs to the end. Watching the real cursor against the
/// rect we set ourselves costs one cheap syscall and cannot miss.
pub fn start_pointer_watch(app: AppHandle) {
    thread::spawn(move || {
        let mut enter_since: Option<Instant> = None;
        let mut leave_since: Option<Instant> = None;

        loop {
            thread::sleep(Duration::from_millis(POINTER_MS));
            let Some((x, y)) = cursor_position() else {
                continue;
            };

            let state = app.state::<Panel>();
            let (inside, expanded, width) = {
                let inner = state.inner.lock().unwrap();
                let g = inner.geometry;
                let (x0, y0) = (g.x * g.scale, g.y * g.scale);
                let (w, h) = (inner.width * g.scale, g.height * g.scale);
                let inside = (x as f64) >= x0
                    && (y as f64) >= y0
                    && (x as f64) < x0 + w
                    && (y as f64) < y0 + h;
                (inside, inner.expanded, inner.width)
            };
            let hold = state.hold.load(Ordering::SeqCst);
            let reduced = state.reduced.load(Ordering::SeqCst);
            let awaiting = state.awaiting_pointer.load(Ordering::SeqCst);

            if inside {
                leave_since = None;
                state.awaiting_pointer.store(false, Ordering::SeqCst);
                if expanded {
                    enter_since = None;
                    continue;
                }
                // An explicit close holds until the pointer actually leaves.
                if state.suppress_hover.load(Ordering::SeqCst) {
                    enter_since = None;
                    continue;
                }
                // Back while the panel is still collapsing: reverse at once. A
                // fresh approach waits for intent so a passing pointer is ignored.
                if width > COLLAPSED_W + 0.5 {
                    enter_since = None;
                    set_expanded(&app, true, reduced);
                    continue;
                }
                let since = *enter_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_millis(HOVER_INTENT_MS) {
                    enter_since = None;
                    set_expanded(&app, true, reduced);
                }
            } else {
                enter_since = None;
                state.suppress_hover.store(false, Ordering::SeqCst);
                if expanded && !hold && !awaiting {
                    let since = *leave_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_millis(LEAVE_DELAY_MS) {
                        leave_since = None;
                        set_expanded(&app, false, reduced);
                    }
                } else {
                    leave_since = None;
                }
            }
        }
    });
}
