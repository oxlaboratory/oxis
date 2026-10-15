//! OXIS's controls, one implementation each, so every button, input and
//! toggle has the same size, states and spacing (see `docs/v2/DESIGN.md`).
//!
//! Controls draw themselves with the draw list over an invisible ImGui
//! item, which gives ImGui's input handling (hover, press, focus, IDs) with
//! none of its default look. Each returns what happened; callers mark
//! hotspots for drive scripts with `Shell::mark` straight after.

use dear_imgui_rs::{ItemHoveredFlags, StyleColor, StyleVar, Ui};

use crate::icons::{self, Icon};
use crate::theme::{alpha, mix, size, space, Fonts, Palette, Rgba};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The one main action in a place: green.
    Primary,
    /// Ordinary actions: a raised surface with a border.
    Secondary,
    /// Destructive actions: red text, a red wash on hover.
    Danger,
}

/// Interaction colours shared by every control.
struct States {
    hovered: bool,
    held: bool,
}

fn states(ui: &Ui) -> States {
    States { hovered: ui.is_item_hovered(), held: ui.is_item_active() }
}

/// A text button, `space::CONTROL` high. `icon` goes before the label.
pub fn button(ui: &Ui, fonts: Fonts, id: &str, label: &str, icon: Option<Icon>, kind: Kind) -> bool {
    let p = Palette::default();
    let _f = ui.push_font_with_size(Some(fonts.ui_medium), size::MD);
    let text_w = ui.calc_text_size(label)[0];
    let icon_w = if icon.is_some() { 16.0 + space::SM } else { 0.0 };
    let w = (text_w + icon_w + 2.0 * space::MD).max(space::CONTROL * 2.0);
    let pos = ui.cursor_screen_pos();
    let clicked = ui.invisible_button(id, [w, space::CONTROL]);
    let s = states(ui);
    let dl = ui.get_window_draw_list();
    let r1 = [pos[0] + w, pos[1] + space::CONTROL];
    let (bg, border, fg): (Rgba, Option<Rgba>, Rgba) = match kind {
        Kind::Primary => (
            if s.held {
                p.acc_lo
            } else if s.hovered {
                p.acc_hi
            } else {
                p.acc
            },
            None,
            [0.04, 0.10, 0.06, 1.0],
        ),
        Kind::Secondary => (
            if s.held {
                mix(p.raised(), p.text, 0.10)
            } else if s.hovered {
                mix(p.raised(), p.text, 0.05)
            } else {
                p.raised()
            },
            Some(p.line2()),
            p.text,
        ),
        Kind::Danger => (
            if s.held {
                alpha(p.err, 0.22)
            } else if s.hovered {
                alpha(p.err, 0.13)
            } else {
                [0.0; 4]
            },
            None,
            p.err,
        ),
    };
    dl.add_rect(pos, r1, bg).filled(true).rounding(4.0).build();
    if let Some(b) = border {
        dl.add_rect(pos, r1, b).rounding(4.0).build();
    }
    // The icon and label, centred together.
    let mut x = pos[0] + (w - text_w - icon_w) / 2.0;
    let cy = pos[1] + space::CONTROL / 2.0;
    if let Some(icon) = icon {
        icons::draw(&dl, icon, [x + 8.0, cy], 14.0, fg);
        x += icon_w;
    }
    dl.add_text_with_font(fonts.ui_medium, size::MD, [x, cy - size::MD * 0.62], fg, label, 0.0, None);
    clicked
}

/// A small square button with an outline, for steppers and the like.
pub fn square_button(ui: &Ui, id: &str, icon: Icon) -> bool {
    let p = Palette::default();
    let pos = ui.cursor_screen_pos();
    let d = space::CONTROL;
    let clicked = ui.invisible_button(id, [d, d]);
    let s = states(ui);
    let dl = ui.get_window_draw_list();
    let bg = if s.held {
        mix(p.raised(), p.text, 0.10)
    } else if s.hovered {
        mix(p.raised(), p.text, 0.05)
    } else {
        p.raised()
    };
    dl.add_rect(pos, [pos[0] + d, pos[1] + d], bg).filled(true).rounding(4.0).build();
    dl.add_rect(pos, [pos[0] + d, pos[1] + d], p.line2()).rounding(4.0).build();
    icons::draw(&dl, icon, [pos[0] + d / 2.0, pos[1] + d / 2.0], 12.0, if s.hovered { p.text } else { p.muted });
    clicked
}

/// A square icon-only button with a tooltip.
pub fn icon_button(ui: &Ui, fonts: Fonts, id: &str, icon: Icon, tip: &str, shortcut: Option<&str>) -> bool {
    let p = Palette::default();
    let pos = ui.cursor_screen_pos();
    let d = space::CONTROL;
    let clicked = ui.invisible_button(id, [d, d]);
    let s = states(ui);
    let dl = ui.get_window_draw_list();
    if s.hovered || s.held {
        dl.add_rect(pos, [pos[0] + d, pos[1] + d], if s.held { p.press() } else { p.hover() }).filled(true).rounding(4.0).build();
    }
    icons::draw(&dl, icon, [pos[0] + d / 2.0, pos[1] + d / 2.0], 16.0, if s.hovered { p.text } else { p.muted });
    tooltip_on_hover(ui, fonts, tip, shortcut);
    clicked
}

/// A tooltip in OXIS's style for the last item, after a short hover.
pub fn tooltip_on_hover(ui: &Ui, fonts: Fonts, text: &str, shortcut: Option<&str>) {
    if ui.is_item_hovered_with_flags(ItemHoveredFlags::DELAY_SHORT | ItemHoveredFlags::NO_SHARED_DELAY) {
        tooltip(ui, fonts, text, shortcut);
    }
}

pub fn tooltip(ui: &Ui, fonts: Fonts, text: &str, shortcut: Option<&str>) {
    let p = Palette::default();
    let _pad = ui.push_style_var(StyleVar::WindowPadding([10.0, 6.0]));
    let _r = ui.push_style_var(StyleVar::PopupRounding(6.0));
    let _bg = ui.push_style_color(StyleColor::PopupBg, p.overlay());
    let _bd = ui.push_style_color(StyleColor::Border, p.line2());
    ui.tooltip(|| {
        let _f = ui.push_font_with_size(Some(fonts.ui_medium), size::SM);
        ui.text(text);
        if let Some(keys) = shortcut {
            ui.same_line_with_spacing(0.0, space::MD);
            let _c = ui.push_style_color(StyleColor::Text, p.dim);
            let _m = ui.push_font_with_size(Some(fonts.mono), size::XS);
            ui.text(keys);
        }
    });
}

/// What a text input did this frame: whether Enter was pressed in it.
pub struct Input {
    pub entered: bool,
}

/// A single-line text input, `space::CONTROL` high, with a focus ring.
/// `mono` sets it in JetBrains Mono (for paths, commands, variables).
pub fn text_input(ui: &Ui, fonts: Fonts, id: &str, value: &mut String, hint: &str, width: f32, mono: bool) -> Input {
    let p = Palette::default();
    let _f = ui.push_font_with_size(Some(if mono { fonts.mono } else { fonts.ui }), size::MD);
    let _pad = ui.push_style_var(StyleVar::FramePadding([10.0, (space::CONTROL - size::MD) / 2.0 - 1.0]));
    let _rnd = ui.push_style_var(StyleVar::FrameRounding(4.0));
    let _bs = ui.push_style_var(StyleVar::FrameBorderSize(1.0));
    let _bg = ui.push_style_color(StyleColor::FrameBg, mix(p.bg, p.bg1, 0.35));
    let _bgh = ui.push_style_color(StyleColor::FrameBgHovered, mix(p.bg, p.bg1, 0.2));
    let _bga = ui.push_style_color(StyleColor::FrameBgActive, mix(p.bg, p.bg1, 0.35));
    let _bd = ui.push_style_color(StyleColor::Border, p.line2());
    let _hint = ui.push_style_color(StyleColor::TextDisabled, p.dim);
    ui.set_next_item_width(width);
    let entered = ui.input_text(id, value).hint(hint).enter_returns_true(true).build();
    if ui.is_item_active() {
        let (a, b) = (ui.item_rect_min(), ui.item_rect_max());
        ui.get_window_draw_list().add_rect(a, b, p.acc).rounding(4.0).thickness(1.0).build();
    }
    Input { entered }
}

/// An on/off switch. Returns whether it was flipped.
pub fn toggle(ui: &Ui, id: &str, on: &mut bool) -> bool {
    let p = Palette::default();
    let (w, h) = (32.0, 18.0);
    let pos = ui.cursor_screen_pos();
    let y = pos[1] + (space::CONTROL - h) / 2.0;
    let clicked = ui.invisible_button(id, [w, space::CONTROL]);
    if clicked {
        *on = !*on;
    }
    let s = states(ui);
    let dl = ui.get_window_draw_list();
    let track = if *on {
        if s.hovered {
            p.acc_hi
        } else {
            p.acc
        }
    } else if s.hovered {
        mix(p.raised(), p.text, 0.16)
    } else {
        mix(p.raised(), p.text, 0.10)
    };
    dl.add_rect([pos[0], y], [pos[0] + w, y + h], track).filled(true).rounding(h / 2.0).build();
    let knob_x = if *on { pos[0] + w - h / 2.0 } else { pos[0] + h / 2.0 };
    dl.add_circle([knob_x, y + h / 2.0], h / 2.0 - 3.0, if *on { [0.06, 0.12, 0.08, 1.0] } else { p.text }).filled(true).build();
    clicked
}

/// A dropdown: shows `current`, opens a menu of `options`, returns the
/// index picked. Options shown dimmed with " (not installed)" and the like
/// are just labels; the caller decides what they mean.
pub fn select(ui: &Ui, fonts: Fonts, id: &str, current: &str, options: &[String], width: f32) -> Option<usize> {
    let p = Palette::default();
    let pos = ui.cursor_screen_pos();
    let popup = format!("{id}-menu");
    if ui.invisible_button(id, [width, space::CONTROL]) {
        ui.open_popup(&popup);
    }
    let s = states(ui);
    let dl = ui.get_window_draw_list();
    let r1 = [pos[0] + width, pos[1] + space::CONTROL];
    dl.add_rect(pos, r1, if s.hovered { mix(p.raised(), p.text, 0.05) } else { p.raised() }).filled(true).rounding(4.0).build();
    dl.add_rect(pos, r1, p.line2()).rounding(4.0).build();
    dl.add_text_with_font(fonts.ui, size::MD, [pos[0] + 10.0, pos[1] + space::CONTROL / 2.0 - size::MD * 0.62], p.text, current, 0.0, None);
    icons::draw(&dl, Icon::ChevronDown, [r1[0] - 14.0, pos[1] + space::CONTROL / 2.0], 12.0, p.muted);

    let mut picked = None;
    next_window_pos([pos[0], r1[1] + 4.0]);
    let _pad = ui.push_style_var(StyleVar::WindowPadding([4.0, 4.0]));
    let _sp = ui.push_style_var(StyleVar::ItemSpacing([0.0, 2.0]));
    let _bg = ui.push_style_color(StyleColor::PopupBg, p.overlay());
    if let Some(_menu) = ui.begin_popup(&popup) {
        let _f = ui.push_font_with_size(Some(fonts.ui), size::MD);
        for (i, opt) in options.iter().enumerate() {
            if menu_item(ui, &format!("{opt}##{id}{i}"), opt == current, width - 8.0) {
                picked = Some(i);
            }
        }
    }
    picked
}

/// One row in a menu: a check for the current choice.
pub fn menu_item(ui: &Ui, label: &str, current: bool, width: f32) -> bool {
    let p = Palette::default();
    let shown = label.split("##").next().unwrap_or(label);
    let pos = ui.cursor_screen_pos();
    let h = 26.0;
    let clicked = ui.invisible_button(label, [width.max(120.0), h]);
    let s = states(ui);
    let dl = ui.get_window_draw_list();
    if s.hovered {
        dl.add_rect(pos, [pos[0] + width.max(120.0), pos[1] + h], p.hover()).filled(true).rounding(4.0).build();
    }
    if current {
        icons::draw(&dl, Icon::Check, [pos[0] + 12.0, pos[1] + h / 2.0], 12.0, p.acc_hi);
    }
    dl.add_text([pos[0] + 26.0, pos[1] + (h - size::MD) / 2.0 - 1.0], if current { p.text } else { p.muted }, shown);
    if clicked {
        ui.close_current_popup();
    }
    clicked
}

/// A small capitalised group label (menus, lists).
pub fn group_label(ui: &Ui, fonts: Fonts, text: &str) {
    let p = Palette::default();
    let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::XS);
    let _c = ui.push_style_color(StyleColor::Text, p.dim);
    ui.text(text.to_uppercase());
}

/// Secondary text, wrapped.
pub fn note(ui: &Ui, fonts: Fonts, text: &str) {
    let p = Palette::default();
    let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
    let _c = ui.push_style_color(StyleColor::Text, p.muted);
    ui.text_wrapped(text);
}

/// Places the next window (a popup or menu) at `pos`, on screen.
pub fn next_window_pos(pos: [f32; 2]) {
    // dear-imgui-rs exposes this only on window builders; popups need it too.
    // (The cast is needed on Linux, where the C enum is unsigned.)
    #[allow(clippy::unnecessary_cast)]
    unsafe {
        dear_imgui_rs::sys::igSetNextWindowPos(
            dear_imgui_rs::sys::ImVec2 { x: pos[0], y: pos[1] },
            dear_imgui_rs::sys::ImGuiCond_Always as i32,
            dear_imgui_rs::sys::ImVec2 { x: 0.0, y: 0.0 },
        );
    }
}

/// Whether the last item is the one under the mouse, as ImGui resolved it
/// this frame. Unlike `is_item_hovered` this holds for overlappable items
/// (large click areas with controls drawn over them).
pub fn hovered_here(ui: &Ui) -> bool {
    let _ = ui;
    unsafe { dear_imgui_rs::sys::igGetHoveredID() == dear_imgui_rs::sys::igGetItemID() && dear_imgui_rs::sys::igGetItemID() != 0 }
}
