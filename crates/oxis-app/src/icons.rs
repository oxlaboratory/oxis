//! The OXIS icon set: one 16-unit grid, 1.5-unit strokes with round
//! joins, drawn as vectors so every icon is sharp at any size and display
//! scale. Coordinates below run from -8 to 8 around the icon's centre.

use dear_imgui_rs::DrawListMut;

use crate::theme::Rgba;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Icon {
    Home,
    Run,
    Terminal,
    Settings,
    Editor,
    Plugins,
    Language,
    Folder,
    Branch,
    Plus,
    Close,
    ChevronDown,
    ChevronRight,
    SplitRight,
    SplitDown,
    Stop,
    Check,
    Alert,
    Minimize,
    Maximize,
    Restore,
    Trash,
    Clock,
}

/// Draws `icon` centred on `c`, `size` logical pixels across.
pub fn draw(dl: &DrawListMut<'_>, icon: Icon, c: [f32; 2], size: f32, color: Rgba) {
    let k = size / 16.0;
    let t = (1.5 * k).max(1.1);
    let p = |x: f32, y: f32| [c[0] + x * k, c[1] + y * k];
    let line = |pts: &[[f32; 2]]| {
        let pts: Vec<[f32; 2]> = pts.iter().map(|q| p(q[0], q[1])).collect();
        dl.add_polyline(pts, color).thickness(t).build();
    };
    let closed = |pts: &[[f32; 2]]| {
        let pts: Vec<[f32; 2]> = pts.iter().map(|q| p(q[0], q[1])).collect();
        dl.add_polyline(pts, color).thickness(t).closed(true).build();
    };
    let circle = |x: f32, y: f32, r: f32| dl.add_circle(p(x, y), r * k, color).thickness(t).build();
    let dot = |x: f32, y: f32, r: f32| dl.add_circle(p(x, y), r * k, color).filled(true).build();
    let rect = |x0: f32, y0: f32, x1: f32, y1: f32, r: f32| dl.add_rect(p(x0, y0), p(x1, y1), color).rounding(r * k).thickness(t).build();
    let arc = |x: f32, y: f32, r: f32, a0: f32, a1: f32| {
        let n = 16;
        let pts: Vec<[f32; 2]> = (0..=n)
            .map(|i| {
                let a = a0 + (a1 - a0) * i as f32 / n as f32;
                p(x + r * a.cos(), y + r * a.sin())
            })
            .collect();
        dl.add_polyline(pts, color).thickness(t).build();
    };
    use std::f32::consts::PI;
    match icon {
        Icon::Home => {
            line(&[[-6.5, -0.5], [0.0, -6.5], [6.5, -0.5]]);
            line(&[[-4.5, -2.0], [-4.5, 6.0], [4.5, 6.0], [4.5, -2.0]]);
            line(&[[-1.5, 6.0], [-1.5, 2.0], [1.5, 2.0], [1.5, 6.0]]);
        }
        Icon::Run => closed(&[[-4.0, -5.5], [5.5, 0.0], [-4.0, 5.5]]),
        Icon::Terminal => {
            rect(-7.0, -6.0, 7.0, 6.0, 1.5);
            line(&[[-4.0, -2.0], [-1.5, 0.0], [-4.0, 2.0]]);
            line(&[[0.5, 2.5], [4.0, 2.5]]);
        }
        Icon::Settings => {
            // A cog: a ring with six short teeth and a hub.
            circle(0.0, 0.0, 4.4);
            for i in 0..6 {
                let a = i as f32 * PI / 3.0;
                line(&[[4.4 * a.cos(), 4.4 * a.sin()], [6.8 * a.cos(), 6.8 * a.sin()]]);
            }
            circle(0.0, 0.0, 1.6);
        }
        Icon::Editor => {
            closed(&[[-5.0, -7.0], [2.0, -7.0], [5.5, -3.5], [5.5, 7.0], [-5.0, 7.0]]);
            line(&[[2.0, -7.0], [2.0, -3.5], [5.5, -3.5]]);
            line(&[[-2.5, 0.5], [2.5, 0.5]]);
            line(&[[-2.5, 3.5], [1.0, 3.5]]);
        }
        Icon::Plugins => {
            // A puzzle piece.
            closed(&[
                [-6.0, -3.0],
                [-2.0, -3.0],
                [-2.0, -4.5],
                [0.0, -6.5],
                [2.0, -4.5],
                [2.0, -3.0],
                [6.0, -3.0],
                [6.0, 1.0],
                [4.5, 1.0],
                [2.5, 3.0],
                [4.5, 5.0],
                [6.0, 5.0],
                [6.0, 7.0],
                [-6.0, 7.0],
            ]);
        }
        Icon::Language => {
            line(&[[-2.5, -6.5], [-4.5, -6.5], [-4.5, -1.5], [-6.5, 0.0], [-4.5, 1.5], [-4.5, 6.5], [-2.5, 6.5]]);
            line(&[[2.5, -6.5], [4.5, -6.5], [4.5, -1.5], [6.5, 0.0], [4.5, 1.5], [4.5, 6.5], [2.5, 6.5]]);
        }
        Icon::Folder => closed(&[[-7.0, -5.5], [-2.5, -5.5], [-1.0, -3.5], [7.0, -3.5], [7.0, 5.5], [-7.0, 5.5]]),
        Icon::Branch => {
            circle(-3.5, -5.0, 1.8);
            circle(-3.5, 5.0, 1.8);
            circle(4.0, -2.5, 1.8);
            line(&[[-3.5, -3.2], [-3.5, 3.2]]);
            line(&[[4.0, -0.7], [4.0, 0.5], [-3.5, 2.5]]);
        }
        Icon::Plus => {
            line(&[[-5.5, 0.0], [5.5, 0.0]]);
            line(&[[0.0, -5.5], [0.0, 5.5]]);
        }
        Icon::Close => {
            line(&[[-4.5, -4.5], [4.5, 4.5]]);
            line(&[[4.5, -4.5], [-4.5, 4.5]]);
        }
        Icon::ChevronDown => line(&[[-4.0, -2.0], [0.0, 2.0], [4.0, -2.0]]),
        Icon::ChevronRight => line(&[[-2.0, -4.0], [2.0, 0.0], [-2.0, 4.0]]),
        Icon::SplitRight => {
            rect(-7.0, -6.0, 7.0, 6.0, 1.5);
            line(&[[0.0, -6.0], [0.0, 6.0]]);
        }
        Icon::SplitDown => {
            rect(-7.0, -6.0, 7.0, 6.0, 1.5);
            line(&[[-7.0, 0.0], [7.0, 0.0]]);
        }
        Icon::Stop => {
            dl.add_rect(p(-4.0, -4.0), p(4.0, 4.0), color).rounding(1.5 * k).filled(true).build();
        }
        Icon::Check => line(&[[-5.5, 0.5], [-1.5, 4.5], [5.5, -4.0]]),
        Icon::Alert => {
            circle(0.0, 0.0, 6.5);
            line(&[[0.0, -3.5], [0.0, 1.0]]);
            dot(0.0, 3.8, 1.0);
        }
        Icon::Minimize => line(&[[-5.0, 0.0], [5.0, 0.0]]),
        Icon::Maximize => rect(-5.0, -5.0, 5.0, 5.0, 0.5),
        Icon::Restore => {
            rect(-5.0, -3.0, 3.0, 5.0, 0.5);
            line(&[[-3.0, -5.0], [5.0, -5.0], [5.0, 3.0]]);
        }
        Icon::Trash => {
            line(&[[-6.0, -4.0], [6.0, -4.0]]);
            line(&[[-2.0, -4.0], [-2.0, -6.0], [2.0, -6.0], [2.0, -4.0]]);
            line(&[[-4.5, -4.0], [-3.8, 6.5], [3.8, 6.5], [4.5, -4.0]]);
        }
        Icon::Clock => {
            circle(0.0, 0.0, 6.5);
            line(&[[0.0, -3.5], [0.0, 0.0], [2.5, 1.5]]);
        }
    }
    let _ = arc;
}
