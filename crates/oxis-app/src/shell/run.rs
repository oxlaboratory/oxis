//! The Run view: one-off commands, each as a block — its status, the
//! command, how long it took and its exit code in the header, its output
//! under it — and the prompt at the bottom.

use dear_imgui_rs::{ChildFlags, Key, StyleColor, StyleVar, Ui, WindowFlags};
use oxide::events::Stream;
use oxide::process::Status;

use super::{Shell, PROMPT_H};
use crate::icons::{self, Icon};
use crate::theme::{alpha, size, space, Fonts};
use crate::widgets::{self, Kind};

const HEADER_H: f32 = 30.0;

impl Shell {
    pub(super) fn run_view(&mut self, ui: &Ui, fonts: Fonts, area: [f32; 4]) {
        let p = self.pal;
        let out_h = area[3] - area[1] - PROMPT_H;
        let here = self.active_id();
        let mut cancel = None;
        let mut toggle = None;
        let mut stops: Vec<(String, [f32; 4])> = Vec::new();

        ui.set_cursor_screen_pos([area[0], area[1]]);
        let _pad = ui.push_style_var(StyleVar::WindowPadding([space::XL, space::LG]));
        let _sp = ui.push_style_var(StyleVar::ItemSpacing([0.0, 0.0]));
        ui.child_window("##runs")
            .size([area[2] - area[0], out_h])
            .child_flags(ChildFlags::ALWAYS_USE_WINDOW_PADDING)
            .flags(WindowFlags::HORIZONTAL_SCROLLBAR)
            .build(ui, || {
                if !self.runs.iter().any(|r| r.owner == here) {
                    {
                        let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::LG);
                        ui.text("Run a command");
                    }
                    ui.dummy([0.0, space::XS]);
                    let where_ = match self.engine.workspaces.active().and_then(|w| w.data.folder.clone()) {
                        Some(f) => format!("in {}", f.display()),
                        None => "in OXIS's own folder (no workspace folder is linked)".to_owned(),
                    };
                    widgets::note(
                        ui,
                        fonts,
                        &format!("Each line runs once as its own process in {}, {where_}, with the workspace's environment. Output, timing and the exit code are kept here. For an interactive shell, use the Terminal.", self.shell_label()),
                    );
                }
                let at_bottom = ui.scroll_y() >= ui.scroll_max_y() - 4.0;
                let width = ui.content_region_avail()[0];
                for (index, run) in self.runs.iter().filter(|r| r.owner == here).enumerate() {
                    let _id = ui.push_id(run.id.raw() as i32);
                    let collapsed = self.collapsed.contains(&run.id);
                    let pos = ui.cursor_screen_pos();
                    let dl = ui.get_window_draw_list();

                    // The header: status, command, timing, actions.
                    let (icon, tint, label) = match run.ended {
                        None => (Icon::Clock, p.acc_hi, format!("{:.0}s", run.started.elapsed().as_secs_f32())),
                        Some((t, st)) => {
                            let secs = (t - run.started).as_secs_f32();
                            match st {
                                Status::Exited { cancelled: true, .. } => (Icon::Stop, p.warn, format!("stopped · {secs:.1}s")),
                                Status::Exited { code: Some(0), .. } => (Icon::Check, p.ok, format!("{secs:.1}s")),
                                Status::Exited { code, .. } => (Icon::Alert, p.err, format!("exit {} · {secs:.1}s", code.map(|c| c.to_string()).unwrap_or("?".into()))),
                                Status::Running => (Icon::Clock, p.muted, String::new()),
                            }
                        }
                    };
                    let hovered = ui.is_mouse_hovering_rect(pos, [pos[0] + width, pos[1] + HEADER_H]);
                    if hovered {
                        dl.add_rect(pos, [pos[0] + width, pos[1] + HEADER_H], p.hover()).filled(true).rounding(4.0).build();
                    }
                    icons::draw(&dl, if collapsed { Icon::ChevronRight } else { Icon::ChevronDown }, [pos[0] + 10.0, pos[1] + HEADER_H / 2.0], 10.0, p.dim);
                    icons::draw(&dl, icon, [pos[0] + 28.0, pos[1] + HEADER_H / 2.0], 13.0, tint);
                    let meta_w = {
                        let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
                        ui.calc_text_size(&label)[0]
                    };
                    let stop_w = if run.ended.is_none() { 64.0 } else { 0.0 };
                    let cmd = {
                        let _f = ui.push_font_with_size(Some(fonts.mono_bold), size::MD);
                        super::elide_middle(ui, &run.command, width - 60.0 - meta_w - stop_w - 24.0)
                    };
                    dl.add_text_with_font(fonts.mono_bold, size::MD, [pos[0] + 44.0, pos[1] + HEADER_H / 2.0 - size::MD * 0.62], p.text, &cmd, 0.0, None);
                    let mx = pos[0] + width - stop_w - meta_w - 8.0;
                    dl.add_text_with_font(fonts.ui, size::SM, [mx, pos[1] + HEADER_H / 2.0 - size::SM * 0.62], if run.ended.is_none() { p.muted } else { tint }, &label, 0.0, None);
                    drop(dl);
                    // A click on the header folds the output away.
                    ui.set_cursor_screen_pos(pos);
                    if ui.invisible_button("##fold", [width - stop_w, HEADER_H]) {
                        toggle = Some(run.id);
                    }
                    if run.ended.is_none() {
                        ui.set_cursor_screen_pos([pos[0] + width - stop_w + 4.0, pos[1] + 1.0]);
                        if widgets::button(ui, fonts, "##stop", "Stop", None, Kind::Danger) {
                            cancel = Some(run.id);
                        }
                        let (a, b) = (ui.item_rect_min(), ui.item_rect_max());
                        stops.push((format!("stop:{index}"), [a[0], a[1], b[0], b[1]]));
                    }
                    ui.set_cursor_screen_pos([pos[0], pos[1] + HEADER_H]);

                    // The output, indented under the command.
                    if !collapsed && (!run.lines.is_empty() || run.dropped > 0) {
                        let top = ui.cursor_screen_pos();
                        let _f = ui.push_font_with_size(Some(fonts.mono), size::MD);
                        let _ind = ui.push_style_var(StyleVar::ItemSpacing([0.0, 1.0]));
                        ui.indent_by(44.0);
                        ui.dummy([0.0, space::XS]);
                        if run.dropped > 0 {
                            let _c = ui.push_style_color(StyleColor::Text, p.dim);
                            ui.text(format!("… {} earlier lines not kept", run.dropped));
                        }
                        for (stream, line) in &run.lines {
                            let _c = ui.push_style_color(StyleColor::Text, if *stream == Stream::Stderr { p.err } else { alpha(p.text, 0.92) });
                            ui.text(line);
                        }
                        ui.unindent_by(44.0);
                        let bottom = ui.cursor_screen_pos()[1];
                        ui.get_window_draw_list().add_line([top[0] + 28.0, top[1] + 2.0], [top[0] + 28.0, bottom - 2.0], p.line2()).build();
                        ui.dummy([0.0, space::XS]);
                    }
                    ui.dummy([0.0, space::SM]);
                }
                if at_bottom {
                    ui.set_scroll_here_y(1.0);
                }
            });
        self.hotspots.extend(stops);
        if let Some(id) = toggle {
            if !self.collapsed.remove(&id) {
                self.collapsed.insert(id);
            }
        }
        // Ctrl+C with nothing typed stops the latest command still running.
        if cancel.is_none() && self.cmd.is_empty() && ui.io().key_ctrl() && ui.is_key_pressed(Key::C) {
            cancel = self.runs.iter().rev().find(|r| r.ended.is_none() && r.owner == here).map(|r| r.id);
        }
        if let Some(id) = cancel {
            if let Err(e) = self.engine.processes.cancel(id) {
                self.say(format!("Couldn't stop it: {e}"), true);
            }
            // Back to the prompt, so the next command can be typed straight away.
            self.focus_cmd = true;
        }

        // The prompt.
        let dl = ui.get_window_draw_list();
        let y = area[3] - PROMPT_H;
        dl.add_rect([area[0], y], [area[2], area[3]], p.chrome2()).filled(true).build();
        dl.add_line([area[0], y + 0.5], [area[2], y + 0.5], p.line()).build();
        icons::draw(&dl, Icon::ChevronRight, [area[0] + space::XL + 4.0, y + PROMPT_H / 2.0], 13.0, p.acc_hi);
        drop(dl);
        ui.set_cursor_screen_pos([area[0] + space::XL + 16.0, y + (PROMPT_H - space::CONTROL) / 2.0]);
        if std::mem::take(&mut self.focus_cmd) {
            ui.set_keyboard_focus_here();
        }
        let hint = format!("Run a command in {}", self.shell_label());
        let _bg = ui.push_style_color(StyleColor::FrameBg, [0.0; 4]);
        let _bgh = ui.push_style_color(StyleColor::FrameBgHovered, [0.0; 4]);
        let _bga = ui.push_style_color(StyleColor::FrameBgActive, [0.0; 4]);
        let _bd = ui.push_style_color(StyleColor::Border, [0.0; 4]);
        let _f = ui.push_font_with_size(Some(fonts.mono), size::MD);
        let _hint = ui.push_style_color(StyleColor::TextDisabled, p.dim);
        let _pad = ui.push_style_var(StyleVar::FramePadding([4.0, 7.0]));
        ui.set_next_item_width(area[2] - area[0] - space::XL * 2.0 - 16.0);
        let entered = ui.input_text("##cmd", &mut self.cmd).hint(hint).enter_returns_true(true).build();
        self.mark(ui, "cmd");
        if entered {
            let line = self.cmd.trim().to_owned();
            self.cmd.clear();
            self.focus_cmd = true;
            if !line.is_empty() {
                self.start_run(line);
            }
        }
    }
}
