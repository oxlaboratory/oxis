//! The window's frame: the title bar, the activity rail, the status bar,
//! toasts and the resize edges. Everything here is drawn the same way at
//! every size; only the content area between them changes.

use dear_imgui_rs::{MouseButton, MouseCursor, StyleColor, StyleVar, Ui};
use winit::window::{ResizeDirection, Window};

use super::{FrameActions, Shell, View, EDGE, RAIL_W, STATUS_H, TITLE_H};
use crate::icons::{self, Icon};
use crate::theme::{alpha, mix, size, space, Fonts};
use crate::widgets;

/// What the rail offers. Planned areas are shown, marked as such, and do
/// nothing when clicked: nothing pretends to work before it does.
const RAIL: &[(Option<View>, Icon, &str, &str)] = &[
    (Some(View::Home), Icon::Home, "Home", "Ctrl+1"),
    (Some(View::Run), Icon::Run, "Run", "Ctrl+2"),
    (Some(View::Terminal), Icon::Terminal, "Terminal", "Ctrl+3"),
    (None, Icon::Editor, "Editor", ""),
    (None, Icon::Plugins, "Plugins", ""),
    (None, Icon::Language, "Language tools", ""),
];

impl View {
    pub(super) fn title(self) -> &'static str {
        match self {
            View::Home => "Home",
            View::Run => "Run",
            View::Terminal => "Terminal",
            View::Settings => "Settings",
        }
    }
}

impl Shell {
    pub(super) fn title_bar(&mut self, ui: &Ui, window: &Window, fonts: Fonts, display: [f32; 2], actions: &mut FrameActions) {
        let p = self.pal;
        let dl = ui.get_window_draw_list();
        dl.add_rect([0.0, 0.0], [display[0], TITLE_H], p.chrome()).filled(true).build();
        dl.add_line([0.0, TITLE_H - 0.5], [display[0], TITLE_H - 0.5], p.line()).build();

        // The logo and the name.
        let mid = TITLE_H / 2.0;
        let logo = 18.0;
        let lx = (RAIL_W - logo) / 2.0;
        match self.logo {
            Some(tex) => dl.add_image(tex, [lx, mid - logo / 2.0], [lx + logo, mid + logo / 2.0], [0.0, 0.0], [1.0, 1.0], [1.0, 1.0, 1.0, 1.0]),
            None => {
                dl.add_circle([RAIL_W / 2.0, mid], 7.0, p.acc).thickness(3.4).build();
            }
        }
        let mut x = RAIL_W + 2.0;
        x += super::spaced_text(ui, &dl, fonts.ui_semibold, size::MD, [x, mid - size::MD * 0.62], p.text, "OXIS", 1.6);
        x += space::MD;
        dl.add_line([x, 11.0], [x, TITLE_H - 11.0], p.line2()).build();
        x += space::SM;

        // The workspace switcher: the folder icon, the name, a chevron.
        let label = self.engine.workspaces.active().map(|w| w.name.clone()).unwrap_or_else(|| "No workspace".into());
        let has_ws = self.engine.workspaces.active().is_some();
        let lw = {
            let _f = ui.push_font_with_size(Some(fonts.ui_medium), size::MD);
            ui.calc_text_size(&label)[0]
        };
        let chip = [x, 6.0, x + lw + 56.0, TITLE_H - 6.0];
        ui.set_cursor_screen_pos([chip[0], chip[1]]);
        if ui.invisible_button("##ws-switch", [chip[2] - chip[0], chip[3] - chip[1]]) {
            ui.open_popup("ws-menu");
        }
        self.mark(ui, "ws-switch");
        let hovered = ui.is_item_hovered();
        let open = ui.is_popup_open("ws-menu");
        if hovered || open {
            dl.add_rect([chip[0], chip[1]], [chip[2], chip[3]], if open { p.press() } else { p.hover() }).filled(true).rounding(4.0).build();
        }
        icons::draw(&dl, Icon::Folder, [chip[0] + 16.0, mid], 14.0, if has_ws { p.acc_hi } else { p.dim });
        dl.add_text_with_font(fonts.ui_medium, size::MD, [chip[0] + 30.0, mid - size::MD * 0.62], if has_ws { p.text } else { p.muted }, &label, 0.0, None);
        icons::draw(&dl, Icon::ChevronDown, [chip[2] - 13.0, mid + 0.5], 11.0, p.muted);
        widgets::tooltip_on_hover(ui, fonts, "Switch workspace", None);
        self.workspace_menu(ui, fonts, [chip[0], chip[3] + 4.0]);

        // Where you are.
        let crumb_x = chip[2] + space::SM;
        icons::draw(&dl, Icon::ChevronRight, [crumb_x + 6.0, mid], 10.0, p.dim);
        dl.add_text_with_font(fonts.ui, size::MD, [crumb_x + 16.0, mid - size::MD * 0.62], p.muted, self.view.title(), 0.0, None);
        let crumb_end = crumb_x + 16.0 + {
            let _f = ui.push_font_with_size(Some(fonts.ui), size::MD);
            ui.calc_text_size(self.view.title())[0]
        };

        // Window controls, right to left, the full height of the bar.
        let bw = 46.0;
        let mut x = display[0] - bw;
        let maximized = window.is_maximized();
        for (i, kind) in [Icon::Close, if maximized { Icon::Restore } else { Icon::Maximize }, Icon::Minimize].into_iter().enumerate() {
            ui.set_cursor_screen_pos([x, 0.0]);
            let clicked = ui.invisible_button(format!("##win{i}"), [bw, TITLE_H - 1.0]);
            self.mark(ui, ["win:close", "win:max", "win:min"][i]);
            let hov = ui.is_item_hovered();
            let held = ui.is_item_active();
            if hov {
                let bg = match (kind, held) {
                    (Icon::Close, false) => [0.77, 0.17, 0.11, 1.0],
                    (Icon::Close, true) => [0.62, 0.13, 0.09, 1.0],
                    (_, false) => p.hover(),
                    (_, true) => p.press(),
                };
                dl.add_rect([x, 0.0], [x + bw, TITLE_H - 1.0], bg).filled(true).build();
            }
            let ic = if hov && kind == Icon::Close {
                [1.0, 1.0, 1.0, 1.0]
            } else if hov {
                p.text
            } else {
                p.muted
            };
            icons::draw(&dl, kind, [x + bw / 2.0, mid], 13.0, ic);
            widgets::tooltip_on_hover(ui, fonts, ["Close", if maximized { "Restore" } else { "Maximise" }, "Minimise"][i], None);
            if clicked {
                match kind {
                    Icon::Close => actions.quit = true,
                    Icon::Minimize => window.set_minimized(true),
                    _ => window.set_maximized(!maximized),
                }
            }
            x -= bw;
        }

        // The rest of the bar moves the window; a double click maximises.
        let drag_x = crumb_end + space::LG;
        let drag_w = (x + bw) - drag_x;
        if drag_w > 0.0 {
            ui.set_cursor_screen_pos([drag_x, 0.0]);
            ui.invisible_button("##drag", [drag_w, TITLE_H - 1.0]);
            if ui.is_item_hovered() && ui.is_mouse_double_clicked(MouseButton::Left) {
                window.set_maximized(!window.is_maximized());
            } else if ui.is_item_active() && ui.is_mouse_dragging(MouseButton::Left) && !self.dragging_title {
                self.dragging_title = true;
                let _ = window.drag_window();
            }
            if !ui.is_mouse_down(MouseButton::Left) {
                self.dragging_title = false;
            }
        }
    }

    fn workspace_menu(&mut self, ui: &Ui, fonts: Fonts, at: [f32; 2]) {
        let p = self.pal;
        widgets::next_window_pos(at);
        // Style that shapes the popup window is pushed before it begins and
        // stays until it ends (tokens drop in reverse order).
        let _pad = ui.push_style_var(StyleVar::WindowPadding([6.0, 6.0]));
        let _sp = ui.push_style_var(StyleVar::ItemSpacing([0.0, 2.0]));
        let _bg = ui.push_style_color(StyleColor::PopupBg, p.overlay());
        let Some(_popup) = ui.begin_popup("ws-menu") else {
            return;
        };
        let width = 240.0;
        ui.set_cursor_pos([ui.cursor_pos()[0] + 8.0, ui.cursor_pos()[1] + 4.0]);
        widgets::group_label(ui, fonts, "Workspaces");
        ui.dummy([width, 2.0]);
        let names = self.engine.workspaces.list().unwrap_or_default();
        let active = self.engine.workspaces.active().map(|w| w.name.clone());
        if names.is_empty() {
            ui.set_cursor_pos([ui.cursor_pos()[0] + 8.0, ui.cursor_pos()[1]]);
            widgets::note(ui, fonts, "No workspaces yet.");
        }
        let _f = ui.push_font_with_size(Some(fonts.ui), size::MD);
        for name in names {
            let is_active = active.as_deref() == Some(&name);
            let picked = widgets::menu_item(ui, &format!("{name}##wsm"), is_active, width);
            self.mark(ui, format!("ws-menu:{name}"));
            if picked && !is_active {
                self.switch_workspace(&name);
            }
        }
        let pos = ui.cursor_screen_pos();
        ui.get_window_draw_list().add_line([pos[0] + 4.0, pos[1] + 3.0], [pos[0] + width - 4.0, pos[1] + 3.0], p.line()).build();
        ui.dummy([width, 6.0]);
        if widgets::menu_item(ui, "Manage workspaces…##wsm", false, width) {
            self.view = View::Home;
            self.focus_new_ws = true;
        }
        self.mark(ui, "ws-menu-manage");
    }

    pub(super) fn switch_workspace(&mut self, name: &str) {
        match self.engine.workspaces.open(name).and_then(|id| self.engine.workspaces.activate(id)) {
            Ok(()) => self.say(format!("Switched to {name}"), false),
            Err(e) => self.say(e.to_string(), true),
        }
    }

    pub(super) fn rail(&mut self, ui: &Ui, fonts: Fonts, display: [f32; 2]) {
        let p = self.pal;
        let dl = ui.get_window_draw_list();
        let (top, bottom) = (TITLE_H, display[1] - STATUS_H);
        dl.add_rect([0.0, top], [RAIL_W, bottom], p.chrome()).filled(true).build();
        dl.add_line([RAIL_W - 0.5, top], [RAIL_W - 0.5, bottom], p.line()).build();

        let cell = 40.0;
        let x0 = (RAIL_W - cell) / 2.0;
        let mut y = top + space::SM;
        let planned_start = RAIL.iter().position(|r| r.0.is_none()).unwrap_or(RAIL.len());
        for (i, (view, icon, name, keys)) in RAIL.iter().enumerate() {
            if i == planned_start {
                // The planned areas sit apart, after a short rule.
                y += space::SM;
                dl.add_line([x0 + 10.0, y], [x0 + cell - 10.0, y], p.line()).build();
                y += space::SM + 1.0;
            }
            self.rail_item(ui, fonts, &dl, *view, *icon, name, keys, [x0, y], cell);
            y += cell + 4.0;
        }
        // Settings at the bottom.
        let sy = bottom - cell - space::SM;
        self.rail_item(ui, fonts, &dl, Some(View::Settings), Icon::Settings, "Settings", "Ctrl+,", [x0, sy], cell);
    }

    #[allow(clippy::too_many_arguments)]
    fn rail_item(
        &mut self,
        ui: &Ui,
        fonts: Fonts,
        dl: &dear_imgui_rs::DrawListMut<'_>,
        view: Option<View>,
        icon: Icon,
        name: &str,
        keys: &str,
        at: [f32; 2],
        cell: f32,
    ) {
        let p = self.pal;
        ui.set_cursor_screen_pos(at);
        let clicked = ui.invisible_button(format!("##rail-{name}"), [cell, cell]);
        let key = name.split_whitespace().next().unwrap_or(name).to_lowercase();
        self.mark(ui, format!("nav:{key}"));
        let hov = ui.is_item_hovered();
        let on = view == Some(self.view);
        let r1 = [at[0] + cell, at[1] + cell];
        match view {
            Some(v) => {
                if clicked {
                    self.go(v);
                }
                if on || hov {
                    dl.add_rect(at, r1, if on { p.wash() } else { p.hover() }).filled(true).rounding(6.0).build();
                }
                if on {
                    dl.add_rect([0.0, at[1] + 10.0], [2.0, r1[1] - 10.0], p.acc).filled(true).build();
                }
                let ic = if on {
                    p.acc_hi
                } else if hov {
                    p.text
                } else {
                    p.muted
                };
                icons::draw(dl, icon, [at[0] + cell / 2.0, at[1] + cell / 2.0], 18.0, ic);
                widgets::tooltip_on_hover(ui, fonts, name, (!keys.is_empty()).then_some(keys));
            }
            None => {
                icons::draw(dl, icon, [at[0] + cell / 2.0, at[1] + cell / 2.0], 18.0, if hov { alpha(p.dim, 0.85) } else { p.faint() });
                widgets::tooltip_on_hover(ui, fonts, &format!("{name} · in development"), None);
            }
        }
    }

    /// Opens a view (from the rail, a shortcut or a link).
    pub(super) fn go(&mut self, view: View) {
        self.view = view;
        if view == View::Run {
            self.focus_cmd = true;
        }
    }

    pub(super) fn status_bar(&self, ui: &Ui, fonts: Fonts, display: [f32; 2]) {
        let p = self.pal;
        let dl = ui.get_window_draw_list();
        let y = display[1] - STATUS_H;
        dl.add_rect([0.0, y], [display[0], display[1]], p.chrome()).filled(true).build();
        dl.add_line([0.0, y + 0.5], [display[0], y + 0.5], p.line()).build();
        let mid = y + STATUS_H / 2.0;
        let ty = mid - size::XS * 0.62;
        let _f = ui.push_font_with_size(Some(fonts.ui), size::XS);
        let width = |t: &str| ui.calc_text_size(t)[0];

        // Left: the workspace, its Git remote, what's running.
        let mut x = space::MD;
        let item = |x: &mut f32, icon: Option<Icon>, text: &str, c| {
            if let Some(i) = icon {
                icons::draw(&dl, i, [*x + 6.0, mid], 11.0, c);
                *x += 16.0;
            }
            dl.add_text_with_font(fonts.ui, size::XS, [*x, ty], c, text, 0.0, None);
            *x += width(text) + space::LG;
        };
        match self.engine.workspaces.active() {
            Some(w) => {
                item(&mut x, Some(Icon::Folder), &w.name, p.muted);
                if let Some(remote) = &w.data.git_remote {
                    item(&mut x, Some(Icon::Branch), &short_remote(remote), p.muted);
                }
            }
            None => item(&mut x, Some(Icon::Folder), "No workspace", p.dim),
        }
        let running = self.runs.iter().filter(|r| r.ended.is_none()).count();
        if running > 0 {
            dl.add_circle([x + 4.0, mid], 3.0, p.acc_hi).filled(true).build();
            x += 12.0;
            item(&mut x, None, &format!("{running} running"), p.acc_hi);
        }

        // Right: the shell, the version.
        let version = format!("OXIS {}", oxide::VERSION);
        let shell = self.shell_label();
        let mut rx = display[0] - space::MD - width(&version);
        dl.add_text_with_font(fonts.ui, size::XS, [rx, ty], p.dim, &version, 0.0, None);
        rx -= width(&shell) + space::LG + 16.0;
        icons::draw(&dl, Icon::Terminal, [rx + 6.0, mid], 11.0, p.dim);
        dl.add_text_with_font(fonts.ui, size::XS, [rx + 16.0, ty], p.dim, &shell, 0.0, None);
    }

    /// A short message at the bottom right, above the status bar: green for
    /// done, red for a problem. Fades after a few seconds; a click on it
    /// dismisses it.
    pub(super) fn notice_toast(&mut self, ui: &Ui, fonts: Fonts, display: [f32; 2], actions: &mut FrameActions) {
        let Some((text, error, at)) = self.notice.clone() else {
            return;
        };
        let age = at.elapsed().as_secs_f32();
        let life = if error { 6.0 } else { 3.5 };
        if age > life {
            self.notice = None;
            return;
        }
        actions.animating = true;
        let p = self.pal;
        let fade = (1.0 - ((age - (life - 0.4)) / 0.4).max(0.0)).min(1.0);
        let dl = ui.get_foreground_draw_list();
        let tw = {
            let _f = ui.push_font_with_size(Some(fonts.ui), size::MD);
            ui.calc_text_size(&text)[0]
        };
        let w = (tw + 52.0).min(display[0] - RAIL_W - 32.0);
        let h = 36.0;
        let x = display[0] - w - space::LG;
        let y = display[1] - STATUS_H - h - space::LG;
        let edge = if error { p.err } else { p.acc };
        dl.add_rect([x, y], [x + w, y + h], alpha(p.overlay(), fade)).filled(true).rounding(6.0).build();
        dl.add_rect([x, y], [x + w, y + h], alpha(p.text, 0.14 * fade)).rounding(6.0).build();
        dl.add_rect([x, y + 8.0], [x + 2.0, y + h - 8.0], alpha(edge, fade)).filled(true).build();
        icons::draw(&dl, if error { Icon::Alert } else { Icon::Check }, [x + 20.0, y + h / 2.0], 13.0, alpha(edge, fade));
        let text = super::elide_middle(ui, &text, w - 52.0);
        dl.add_text_with_font(
            fonts.ui,
            size::MD,
            [x + 36.0, y + h / 2.0 - size::MD * 0.62],
            alpha(mix(p.text, edge, if error { 0.25 } else { 0.0 }), fade),
            &text,
            0.0,
            None,
        );
        let m = ui.io().mouse_pos();
        if ui.is_mouse_clicked(MouseButton::Left) && m[0] >= x && m[0] <= x + w && m[1] >= y && m[1] <= y + h {
            self.notice = None;
        }
    }

    pub(super) fn resize_edges(&self, ui: &Ui, window: &Window, display: [f32; 2]) {
        if window.is_maximized() {
            return;
        }
        let [mx, my] = ui.io().mouse_pos();
        let (l, r, t, b) = (mx < EDGE, mx > display[0] - EDGE, my < EDGE, my > display[1] - EDGE);
        let dir = match (l, r, t, b) {
            (true, _, true, _) => Some((ResizeDirection::NorthWest, MouseCursor::ResizeNWSE)),
            (_, true, true, _) => Some((ResizeDirection::NorthEast, MouseCursor::ResizeNESW)),
            (true, _, _, true) => Some((ResizeDirection::SouthWest, MouseCursor::ResizeNESW)),
            (_, true, _, true) => Some((ResizeDirection::SouthEast, MouseCursor::ResizeNWSE)),
            (true, ..) => Some((ResizeDirection::West, MouseCursor::ResizeEW)),
            (_, true, ..) => Some((ResizeDirection::East, MouseCursor::ResizeEW)),
            (_, _, true, _) => Some((ResizeDirection::North, MouseCursor::ResizeNS)),
            (_, _, _, true) => Some((ResizeDirection::South, MouseCursor::ResizeNS)),
            _ => None,
        };
        if let Some((d, cursor)) = dir {
            ui.set_mouse_cursor(Some(cursor));
            if ui.is_mouse_clicked(MouseButton::Left) {
                let _ = window.drag_resize_window(d);
            }
        }
    }
}

/// `https://github.com/owner/repo.git` → `owner/repo`; `git@host:o/r.git`
/// → `o/r`; anything else as it is.
pub(super) fn short_remote(url: &str) -> String {
    let s = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let path = if let Some((_, rest)) = s.split_once("://") {
        rest.split_once('/').map(|(_, p)| p).unwrap_or(rest)
    } else if let Some((_, rest)) = s.split_once(':') {
        rest
    } else {
        s
    };
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => url.to_owned(),
        1 => parts[0].to_owned(),
        n => format!("{}/{}", parts[n - 2], parts[n - 1]),
    }
}

#[cfg(test)]
mod tests {
    use super::short_remote;

    #[test]
    fn remotes_shorten_to_owner_and_repo() {
        assert_eq!(short_remote("https://github.com/oxlaboratory/oxis.git"), "oxlaboratory/oxis");
        assert_eq!(short_remote("git@github.com:oxlaboratory/oxis.git"), "oxlaboratory/oxis");
        assert_eq!(short_remote("ssh://git@host:22/a/b/c"), "b/c");
        assert_eq!(short_remote("/srv/git/project.git"), "git/project");
    }
}
