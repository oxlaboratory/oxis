//! Where the window opens and how big it is.
//!
//! The first time, OXIS takes about four fifths of the screen it opens on
//! (capped at 1440×900 and never smaller than the minimum), centred. After
//! that it reopens where it was — unless that place is no longer on any
//! screen (a monitor was unplugged), in which case it's placed afresh.
//! Sizes are stored in logical pixels, so a change of display scale
//! doesn't make the window huge or tiny.

use serde::{Deserialize, Serialize};
use winit::dpi::{LogicalPosition, LogicalSize, PhysicalPosition};
use winit::event_loop::ActiveEventLoop;
use winit::window::Window;

use oxide::config::Document;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub maximized: bool,
}

impl Document for WindowState {
    const FORMAT: u32 = 1;
}

pub struct Placement {
    pub size: LogicalSize<f64>,
    pub position: Option<LogicalPosition<f64>>,
    pub maximized: bool,
}

pub fn initial_placement(el: &ActiveEventLoop, saved: &WindowState) -> Placement {
    let monitor = el.primary_monitor().or_else(|| el.available_monitors().next());
    let Some(monitor) = monitor else {
        return Placement { size: LogicalSize::new(1180.0, 760.0), position: None, maximized: false };
    };
    let scale = monitor.scale_factor();
    let screen: LogicalSize<f64> = monitor.size().to_logical(scale);
    let origin: LogicalPosition<f64> = monitor.position().to_logical(scale);

    if saved.width >= 720.0 && saved.height >= 460.0 {
        if let (Some(x), Some(y)) = (saved.x, saved.y) {
            let visible = el.available_monitors().any(|m| {
                let s = m.scale_factor();
                let p: LogicalPosition<f64> = m.position().to_logical(s);
                let z: LogicalSize<f64> = m.size().to_logical(s);
                // At least the title bar's left end is on this screen.
                x + 80.0 > p.x && x < p.x + z.width - 40.0 && y >= p.y - 4.0 && y < p.y + z.height - 40.0
            });
            if visible {
                return Placement {
                    size: LogicalSize::new(saved.width.min(screen.width), saved.height.min(screen.height)),
                    position: Some(LogicalPosition::new(x, y)),
                    maximized: saved.maximized,
                };
            }
        }
    }

    let w = (screen.width * 0.8).clamp(720.0, 1440.0).min(screen.width);
    let h = (screen.height * 0.8).clamp(460.0, 900.0).min(screen.height);
    Placement {
        size: LogicalSize::new(w, h),
        position: Some(LogicalPosition::new(origin.x + (screen.width - w) / 2.0, origin.y + (screen.height - h) / 2.0)),
        maximized: false,
    }
}

/// The window's current placement, to save. A maximised window keeps its
/// last normal size underneath.
pub fn capture(window: &Window, previous: &WindowState) -> WindowState {
    let scale = window.scale_factor();
    let maximized = window.is_maximized();
    if maximized {
        return WindowState { maximized, ..previous.clone() };
    }
    let size: LogicalSize<f64> = window.inner_size().to_logical(scale);
    let pos: Option<LogicalPosition<f64>> = window.outer_position().ok().map(|p: PhysicalPosition<i32>| p.to_logical(scale));
    WindowState { width: size.width, height: size.height, x: pos.map(|p| p.x), y: pos.map(|p| p.y), maximized }
}
