use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::easing::make_ease;

/// Closed: one circle carrying the mark.
pub const ORB: f64 = 56.0;
/// First open: a small card holding the selected project and the log field.
pub const POPOVER_W: f64 = 320.0;
pub const POPOVER_H: f64 = 190.0;
pub const EXPANDED_W: f64 = 370.0;
const EXPAND_MS: u64 = 340;
const COLLAPSE_MS: u64 = 280;
const FRAME_MS: u64 = 16;
const POINTER_MS: u64 = 20;
const HOVER_INTENT_MS: u64 = 80;
const LEAVE_DELAY_MS: u64 = 450;
/// Air between the panel and the left edge. The orb floats the same distance,
/// so opening reads as the circle growing into the card.
const EDGE_GAP: f64 = 16.0;
const MAX_HEIGHT: f64 = 580.0;
const MIN_V_GAP: f64 = 24.0;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Circle,
    Popover,
    Panel,
}

impl Mode {
    pub fn key(self) -> &'static str {
        match self {
            Mode::Circle => "circle",
            Mode::Popover => "popover",
            Mode::Panel => "panel",
        }
    }

    pub fn parse(key: &str) -> Mode {
        match key {
            "panel" => Mode::Panel,
            "popover" => Mode::Popover,
            _ => Mode::Circle,
        }
    }

    fn open(self) -> bool {
        self != Mode::Circle
    }

    /// Width, height and top edge of this mode.
    pub fn frame(self, geometry: &Geometry) -> (f64, f64, f64) {
        match self {
            Mode::Circle => (ORB, ORB, geometry.orb_y),
            Mode::Popover => (POPOVER_W, POPOVER_H, geometry.popover_y),
            Mode::Panel => (EXPANDED_W, geometry.height, geometry.panel_y),
        }
    }

    /// Corner radius of this mode; the circle is half the orb.
    pub fn radius(self) -> f64 {
        match self {
            Mode::Circle => ORB / 2.0,
            _ => 20.0,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Geometry {
    pub x: f64,
    pub panel_y: f64,
    pub orb_y: f64,
    pub popover_y: f64,
    pub height: f64,
    pub scale: f64,
}

struct Inner {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    radius: f64,
    mode: Mode,
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
                width: ORB,
                height: ORB,
                x: 0.0,
                y: 0.0,
                radius: ORB / 2.0,
                mode: Mode::Circle,
                geometry: Geometry {
                    x: 0.0,
                    panel_y: 0.0,
                    orb_y: 0.0,
                    popover_y: 0.0,
                    height: 580.0,
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

    // Tall enough to breathe, short enough to float: never taller than the
    // screen can hold with even margins above and below.
    let height = (ah - MIN_V_GAP * 2.0).min(MAX_HEIGHT).round();
    let orb_y = ay + ((ah - ORB) / 2.0).round();
    // The popover shares the orb's centre line, so it opens around it.
    let popover_y = (orb_y + ORB / 2.0 - POPOVER_H / 2.0).round();
    Geometry {
        x: ax + EDGE_GAP,
        panel_y: ay + ((ah - height) / 2.0).round(),
        orb_y,
        popover_y,
        height,
        scale,
    }
}

pub fn adopt(app: &AppHandle, geometry: Geometry) {
    let state = app.state::<Panel>();
    let mut inner = state.inner.lock().unwrap();
    let (width, height, y) = Mode::Circle.frame(&geometry);
    inner.geometry = geometry;
    inner.width = width;
    inner.height = height;
    inner.x = geometry.x;
    inner.y = y;
    inner.radius = Mode::Circle.radius();
    inner.mode = Mode::Circle;
}

pub fn set_hold(app: &AppHandle, hold: bool) {
    app.state::<Panel>().hold.store(hold, Ordering::SeqCst);
}

pub fn set_reduced(app: &AppHandle, reduced: bool) {
    app.state::<Panel>().reduced.store(reduced, Ordering::SeqCst);
}

/// Acrylic covers the whole native rectangle, so the corners the CSS rounds
/// away still showed a faint square. Clipping the window to the same shape
/// removes it (and a square window shows through a circular orb), and makes
/// the rounding real for the pointer as well.
#[cfg(target_os = "windows")]
fn clip_to_round(window: &WebviewWindow, width: f64, height: f64, radius: f64, scale: f64) {
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;
    // Never wider than half the short side: at 56x56 that is a circle.
    let r = (radius.min(width / 2.0).min(height / 2.0) * scale).round() as i32;
    // SAFETY: the region is created here and handed to the window, which owns
    // it from that moment on.
    unsafe {
        let region = CreateRoundRectRgn(0, 0, w + 1, h + 1, r * 2, r * 2);
        if !region.is_null() {
            SetWindowRgn(hwnd.0, region, 1);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn clip_to_round(_: &WebviewWindow, _: f64, _: f64, _: f64, _: f64) {}

/// Size, place and clip in one go: the three always agree.
fn apply(window: &WebviewWindow, width: f64, height: f64, x: f64, y: f64, radius: f64, scale: f64) {
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_position(LogicalPosition::new(x, y));
    clip_to_round(window, width, height, radius, scale);
}

pub fn clip_now(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let state = app.state::<Panel>();
        let inner = state.inner.lock().unwrap();
        clip_to_round(
            &window,
            inner.width,
            inner.height,
            inner.radius,
            inner.geometry.scale,
        );
    }
}

pub fn toggle(app: &AppHandle) {
    let (mode, reduced) = {
        let state = app.state::<Panel>();
        let mode = state.inner.lock().unwrap().mode;
        (mode, state.reduced.load(Ordering::SeqCst))
    };
    // Hidden in the tray counts as closed, whatever the mode was.
    let hidden = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .map(|visible| !visible)
        .unwrap_or(false);
    let next = if hidden || mode == Mode::Circle {
        Mode::Popover
    } else {
        Mode::Circle
    };
    set_by_user(app, next, reduced);
}

/// Closing on purpose: the pointer may still be sitting on the panel, and it
/// must not count as a reason to open again until it has left and come back.
pub fn set_by_user(app: &AppHandle, mode: Mode, instant: bool) {
    let state = app.state::<Panel>();
    if mode.open() {
        state.awaiting_pointer.store(true, Ordering::SeqCst);
    } else {
        state.suppress_hover.store(true, Ordering::SeqCst);
    }
    set_mode(app, mode, instant);
}

/// Windows paints the acrylic across the whole window rectangle, region or no
/// region, so a 56px orb would sit on a dark square. Blur earns its keep on the
/// cards and is invisible on a dot, so it is only on while something is open.
#[cfg(target_os = "windows")]
fn glass(window: &WebviewWindow, open: bool) {
    if open {
        if window_vibrancy::apply_acrylic(window, Some((7, 17, 31, 160))).is_err() {
            let _ = window.eval("document.documentElement.classList.add('no-glass')");
        }
    } else {
        let _ = window_vibrancy::clear_acrylic(window);
    }
}

#[cfg(not(target_os = "windows"))]
fn glass(_: &WebviewWindow, _: bool) {}

pub fn set_mode(app: &AppHandle, mode: Mode, instant: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Closed to the tray: the window has to come back before it can grow.
    if mode.open() && !window.is_visible().unwrap_or(true) {
        let _ = window.show();
    }
    if mode.open() {
        glass(&window, true);
    }
    let state = app.state::<Panel>();

    // Any new request invalidates the run in flight; the running frame notices
    // and stops, so the panel never fights itself.
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let (from_w, from_h, from_y, from_r, to_w, to_h, to_y, to_r, x, scale) = {
        let mut inner = state.inner.lock().unwrap();
        let (width, height, y) = mode.frame(&inner.geometry);
        inner.mode = mode;
        (
            inner.width, inner.height, inner.y, inner.radius, width, height, y,
            mode.radius(), inner.x, inner.geometry.scale,
        )
    };

    // Told before the surface moves: the renderer's content fade belongs to the
    // same movement, not to a later round trip.
    let _ = app.emit("panel:state", mode.key());

    let settle = |inner: &mut Inner, width: f64, height: f64, y: f64, radius: f64| {
        inner.width = width;
        inner.height = height;
        inner.y = y;
        inner.radius = radius;
    };

    let still = (to_w - from_w).abs() < 0.5
        && (to_h - from_h).abs() < 0.5
        && (to_y - from_y).abs() < 0.5;
    if instant || still {
        settle(&mut state.inner.lock().unwrap(), to_w, to_h, to_y, to_r);
        apply(&window, to_w, to_h, x, to_y, to_r, scale);
        if !mode.open() {
            glass(&window, false);
        }
        return;
    }

    let opening = to_w > from_w || to_h > from_h;
    let app = app.clone();
    thread::spawn(move || {
        let duration = Duration::from_millis(if opening { EXPAND_MS } else { COLLAPSE_MS });
        let ease = if opening {
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
            let eased = ease(progress);
            let width = from_w + (to_w - from_w) * eased;
            let height = from_h + (to_h - from_h) * eased;
            let y = from_y + (to_y - from_y) * eased;
            let radius = from_r + (to_r - from_r) * eased;
            settle(&mut state.inner.lock().unwrap(), width, height, y, radius);

            if let Some(window) = app.get_webview_window("main") {
                apply(&window, width, height, x, y, radius, scale);
            }
            if progress >= 1.0 {
                break;
            }
        }

        // The frost is dropped only once the card has finished shrinking back
        // into the orb, so a collapse never goes dull mid-flight.
        if !opening {
            let state = app.state::<Panel>();
            if state.generation.load(Ordering::SeqCst) == generation {
                if let Some(window) = app.get_webview_window("main") {
                    glass(&window, false);
                }
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
            let (inside, open, mid) = {
                let inner = state.inner.lock().unwrap();
                let g = inner.geometry;
                let x0 = inner.x * g.scale;
                let y0 = inner.y * g.scale;
                let (w, h) = (inner.width * g.scale, inner.height * g.scale);
                let inside = (x as f64) >= x0
                    && (y as f64) >= y0
                    && (x as f64) < x0 + w
                    && (y as f64) < y0 + h;
                (inside, inner.mode.open(), inner.width > ORB + 0.5)
            };
            let hold = state.hold.load(Ordering::SeqCst);
            let reduced = state.reduced.load(Ordering::SeqCst);
            let awaiting = state.awaiting_pointer.load(Ordering::SeqCst);

            if inside {
                leave_since = None;
                state.awaiting_pointer.store(false, Ordering::SeqCst);
                if open {
                    enter_since = None;
                    continue;
                }
                // An explicit close holds until the pointer actually leaves.
                if state.suppress_hover.load(Ordering::SeqCst) {
                    enter_since = None;
                    continue;
                }
                // Back while the orb is still growing back: reverse at once. A
                // fresh approach waits for intent so a passing pointer is ignored.
                if mid {
                    enter_since = None;
                    set_mode(&app, Mode::Popover, reduced);
                    continue;
                }
                let since = *enter_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_millis(HOVER_INTENT_MS) {
                    enter_since = None;
                    set_mode(&app, Mode::Popover, reduced);
                }
            } else {
                enter_since = None;
                state.suppress_hover.store(false, Ordering::SeqCst);
                if open && !hold && !awaiting {
                    let since = *leave_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_millis(LEAVE_DELAY_MS) {
                        leave_since = None;
                        set_mode(&app, Mode::Circle, reduced);
                    }
                } else {
                    leave_since = None;
                }
            }
        }
    });
}
