//! Settings: grouped rows, each a label and description on the left and
//! its control on the right, saved through the engine the moment they
//! change.

use dear_imgui_rs::{ChildFlags, StyleColor, StyleVar, Ui};

use super::Shell;
use crate::icons::Icon;
use crate::theme::{size, space, Fonts};
use crate::widgets;

/// The widest the settings column gets: lines stay readable on big screens.
const COLUMN: f32 = 720.0;

impl Shell {
    pub(super) fn settings(&mut self, ui: &Ui, fonts: Fonts, area: [f32; 4]) {
        let p = self.pal;
        ui.set_cursor_screen_pos([area[0], area[1]]);
        let _pad = ui.push_style_var(StyleVar::WindowPadding([space::XXL, space::XL]));
        ui.child_window("##settings").size([area[2] - area[0], area[3] - area[1]]).child_flags(ChildFlags::ALWAYS_USE_WINDOW_PADDING).build(ui, || {
            let width = ui.content_region_avail()[0].min(COLUMN);
            {
                let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::TITLE);
                ui.text("Settings");
            }
            {
                let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
                let _c = ui.push_style_color(StyleColor::Text, p.muted);
                ui.text("Changes are saved as you make them.");
            }
            let path = self.engine.data_dir().join("settings.json");
            widgets::tooltip_on_hover(ui, fonts, &path.display().to_string(), None);
            ui.dummy([0.0, space::XL]);
            let mut changed = false;

            self.group(ui, fonts, "Terminal", width);
            let about = if cfg!(windows) {
                "For terminals and the Run view. Auto picks PowerShell 7 if it's installed, else Windows PowerShell."
            } else {
                "For terminals and the Run view. Auto uses your $SHELL."
            };
            self.row(ui, fonts, "Shell", about, width, 220.0, |s| {
                let mut choices: Vec<String> = std::iter::once("auto".to_owned()).chain(s.installed_shells.iter().cloned()).collect();
                let current = s.engine.settings.shell.clone();
                let missing = !choices.contains(&current);
                if missing {
                    choices.push(current.clone());
                }
                let shown = if missing { format!("{current} (not installed)") } else { current.clone() };
                if let Some(i) = widgets::select(ui, fonts, "##shell", &shown, &choices, 220.0) {
                    if choices[i] != current {
                        s.engine.settings.shell = choices[i].clone();
                        changed = true;
                    }
                }
                s.mark(ui, "setting:shell");
            });
            self.row(ui, fonts, "Font size", "The size of text in terminals.", width, 96.0, |s| {
                let size_now = s.engine.settings.font_size;
                if widgets::square_button(ui, "##font-down", Icon::Minimize) && size_now > 9.0 {
                    s.engine.settings.font_size = (size_now - 1.0).max(9.0);
                    changed = true;
                }
                s.mark(ui, "setting:font-");
                ui.same_line_with_spacing(0.0, 0.0);
                let pos = ui.cursor_screen_pos();
                let label = format!("{:.0}", s.engine.settings.font_size);
                ui.dummy([40.0, space::CONTROL]);
                let tw = {
                    let _f = ui.push_font_with_size(Some(fonts.mono), size::MD);
                    ui.calc_text_size(&label)[0]
                };
                ui.get_window_draw_list().add_text_with_font(
                    fonts.mono,
                    size::MD,
                    [pos[0] + 20.0 - tw / 2.0, pos[1] + space::CONTROL / 2.0 - size::MD * 0.62],
                    s.pal.text,
                    &label,
                    0.0,
                    None,
                );
                ui.same_line_with_spacing(0.0, 0.0);
                if widgets::square_button(ui, "##font-up", Icon::Plus) && size_now < 28.0 {
                    s.engine.settings.font_size = (size_now + 1.0).min(28.0);
                    changed = true;
                }
                s.mark(ui, "setting:font+");
            });
            ui.dummy([0.0, space::LG]);

            self.group(ui, fonts, "Startup", width);
            self.row(ui, fonts, "Restore session", "Reopen the workspace you were in when OXIS starts.", width, 32.0, |s| {
                changed |= widgets::toggle(ui, "##restore", &mut s.engine.settings.restore_session);
                s.mark(ui, "setting:restore");
            });

            if changed {
                self.refresh_shell_label();
                match self.engine.save_settings() {
                    Ok(()) => self.say("Saved", false),
                    Err(e) => self.say(e.to_string(), true),
                }
            }
        });
    }

    fn group(&self, ui: &Ui, fonts: Fonts, title: &str, width: f32) {
        {
            let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::LG);
            ui.text(title);
        }
        let pos = ui.cursor_screen_pos();
        ui.get_window_draw_list().add_line([pos[0], pos[1] + 4.0], [pos[0] + width, pos[1] + 4.0], self.pal.line()).build();
        ui.dummy([0.0, space::SM]);
    }

    /// One setting: label and description on the left, `control` (of
    /// `control_w`) right-aligned, a hairline under it.
    #[allow(clippy::too_many_arguments)]
    fn row(&mut self, ui: &Ui, fonts: Fonts, label: &str, about: &str, width: f32, control_w: f32, control: impl FnOnce(&mut Self)) {
        let p = self.pal;
        let top = ui.cursor_screen_pos();
        let local_x = ui.cursor_pos()[0];
        let text_w = width - control_w - space::XL;
        {
            let _f = ui.push_font_with_size(Some(fonts.ui_medium), size::MD);
            ui.text(label);
        }
        {
            let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
            let _c = ui.push_style_color(StyleColor::Text, p.muted);
            let _w = ui.push_text_wrap_pos(local_x + text_w);
            ui.text(about);
        }
        let text_bottom = ui.cursor_screen_pos()[1];
        let row_h = (text_bottom - top[1]).max(space::CONTROL);
        ui.set_cursor_screen_pos([top[0] + width - control_w, top[1] + (row_h - space::CONTROL) / 2.0]);
        control(self);
        ui.set_cursor_screen_pos([top[0], top[1] + row_h + space::MD]);
        let y = ui.cursor_screen_pos()[1];
        ui.get_window_draw_list().add_line([top[0], y], [top[0] + width, y], p.line()).build();
        ui.dummy([width, space::MD]);
    }
}
