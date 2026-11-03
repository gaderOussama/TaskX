use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::easing::make_ease;

/// Closed: one square tile carrying the mark.
pub const ORB: f64 = 56.0;
/// First open: a small card holding the starred projects and the log field.
/// Its height follows its content, which the page measures and reports.
pub const POPOVER_W: f64 = 320.0;
pub const POPOVER_H: f64 = 200.0;
/// The dashboard: project list on the left, the selected project on the right.
pub const EXPANDED_W: f64 = 720.0;
const EXPAND_MS: u64 = 340;
const COLLAPSE_MS: u64 = 280;
const FRAME_MS: u64 = 16;
const POINTER_MS: u64 = 20;
const HOVER_INTENT_MS: u64 = 80;
const LEAVE_DELAY_MS: u64 = 450;
/// Air between the panel and the left edge. The orb floats the same distance,
/// so opening reads as the tile growing into the card.
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

    /// Width, height, left edge and top edge of this mode. Only the resting tile
    /// sits out past the screen edge; the cards open at the panel's inset.
    pub fn frame(self, geometry: &Geometry, card_h: f64) -> (f64, f64, f64, f64) {
        match self {
            Mode::Circle => (ORB, ORB, geometry.orb_x, geometry.orb_y),
            Mode::Popover => {
                // Opens around the orb's centre line, but never past the
                // panel's own top and bottom margins.
                let height = card_h.min(geometry.height);
                let top = geometry.panel_y;
                let y = (geometry.orb_y + ORB / 2.0 - height / 2.0)
                    .round()
                    .clamp(top, top + geometry.height - height);
                (POPOVER_W, height, geometry.x, y)
            }
            Mode::Panel => (EXPANDED_W, geometry.height, geometry.x, geometry.panel_y),
        }
    }

}

#[derive(Clone, Copy)]
pub struct Geometry {
    pub x: f64,
    pub orb_x: f64,
    pub panel_y: f64,
    pub orb_y: f64,
    pub height: f64,
    pub scale: f64,
}

struct Inner {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    mode: Mode,
    geometry: Geometry,
    card_h: f64,
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
                mode: Mode::Circle,
                geometry: Geometry {
                    x: 0.0,
                    orb_x: 0.0,
                    panel_y: 0.0,
                    orb_y: 0.0,
                    height: 580.0,
                    scale: 1.0,
                },
                card_h: POPOVER_H,
            }),
            generation: AtomicU64::new(0),
            hold: AtomicBool::new(false),
            reduced: AtomicBool::new(false),
            suppress_hover: AtomicBool::new(false),
            awaiting_pointer: AtomicBool::new(false),
        }
    }
}

/// Where every mode sits on the current monitor's work area.
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
    Geometry {
        x: ax + EDGE_GAP,
        // Half the tile hangs past the screen edge: present, but not in the way.
        orb_x: ax - ORB / 2.0,
        panel_y: ay + ((ah - height) / 2.0).round(),
        orb_y,
        height,
        scale,
    }
}

pub fn adopt(app: &AppHandle, geometry: Geometry) {
    let state = app.state::<Panel>();
    let mut inner = state.inner.lock().unwrap();
    let (width, height, x, y) = Mode::Circle.frame(&geometry, inner.card_h);
    inner.geometry = geometry;
    inner.width = width;
    inner.height = height;
    inner.x = x;
    inner.y = y;
    inner.mode = Mode::Circle;
}

pub fn set_hold(app: &AppHandle, hold: bool) {
    app.state::<Panel>().hold.store(hold, Ordering::SeqCst);
}

pub fn set_reduced(app: &AppHandle, reduced: bool) {
    app.state::<Panel>().reduced.store(reduced, Ordering::SeqCst);
}

/// The card's content changed height: if it is open, grow or shrink to fit.
pub fn set_card_height(app: &AppHandle, height: f64) {
    let state = app.state::<Panel>();
    let refit = {
        let mut inner = state.inner.lock().unwrap();
        if (inner.card_h - height).abs() < 0.5 {
            return;
        }
        inner.card_h = height;
        inner.mode == Mode::Popover
    };
    if refit {
        set_mode(app, Mode::Popover, state.reduced.load(Ordering::SeqCst));
    }
}

/// Size and place together: a window that resizes before it moves flickers.
fn apply(window: &WebviewWindow, width: f64, height: f64, x: f64, y: f64) {
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_position(LogicalPosition::new(x, y));
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
    // Summoned from the keyboard or tray: take focus so the log field is ready
    // to type into. Hover never does this, it would steal from the app in use.
    if next.open() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
        let _ = app.emit("panel:focus", ());
    }
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

pub fn set_mode(app: &AppHandle, mode: Mode, instant: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Closed to the tray: the window has to come back before it can grow.
    if mode.open() && !window.is_visible().unwrap_or(true) {
        let _ = window.show();
    }
    let state = app.state::<Panel>();

    // Any new request invalidates the run in flight; the running frame notices
    // and stops, so the panel never fights itself.
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // ponytail: re-measured per move, so a resolution or taskbar change made
    // while resting is only picked up on the next open or close. Measured
    // before the lock: asking the window may wait on the main thread.
    let geometry = measure(&window);

    let (from_w, from_h, from_x, from_y, to_w, to_h, to_x, to_y) = {
        let mut inner = state.inner.lock().unwrap();
        inner.geometry = geometry;
        let (width, height, x, y) = mode.frame(&inner.geometry, inner.card_h);
        inner.mode = mode;
        (
            inner.width,
            inner.height,
            inner.x,
            inner.y,
            width,
            height,
            x,
            y,
        )
    };

    // Told before the surface moves: the renderer's content fade belongs to the
    // same movement, not to a later round trip.
    let _ = app.emit("panel:state", mode.key());

    let settle = |inner: &mut Inner, width: f64, height: f64, x: f64, y: f64| {
        inner.width = width;
        inner.height = height;
        inner.x = x;
        inner.y = y;
    };

    let still = (to_w - from_w).abs() < 0.5
        && (to_h - from_h).abs() < 0.5
        && (to_x - from_x).abs() < 0.5
        && (to_y - from_y).abs() < 0.5;
    if instant || still {
        settle(&mut state.inner.lock().unwrap(), to_w, to_h, to_x, to_y);
        apply(&window, to_w, to_h, to_x, to_y);
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
            let x = from_x + (to_x - from_x) * eased;
            let y = from_y + (to_y - from_y) * eased;
            settle(&mut state.inner.lock().unwrap(), width, height, x, y);

            if let Some(window) = app.get_webview_window("main") {
                apply(&window, width, height, x, y);
            }
            if progress >= 1.0 {
                break;
            }
        }
        // A resize can be coalesced away under the tween's frame rate; landing
        // the final size once more keeps the webview's bounds in step with it.
        if let Some(window) = app.get_webview_window("main") {
            apply(&window, to_w, to_h, to_x, to_y);
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
