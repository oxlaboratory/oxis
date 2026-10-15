//! Home: the workspaces. A list on the left (each with its folder and what
//! it's running), the active workspace's details on the right, editable in
//! place. The page never scrolls; a long list or environment scrolls
//! inside its own column.

use dear_imgui_rs::{ChildFlags, StyleColor, StyleVar, Ui, WindowFlags};
use oxide::workspace::WorkspaceData;

use super::{expand_home, Shell, View};
use crate::icons::{self, Icon};
use crate::theme::{alpha, size, space, Fonts};
use crate::widgets::{self, Kind};

const LIST_ROW_H: f32 = 52.0;

impl Shell {
    pub(super) fn home(&mut self, ui: &Ui, fonts: Fonts, area: [f32; 4]) {
        let p = self.pal;
        let w = area[2] - area[0];
        let h = area[3] - area[1];
        // The list takes about a third, within sensible bounds.
        let list_w = (w * 0.32).clamp(240.0, 340.0);
        let dl = ui.get_window_draw_list();
        dl.add_rect([area[0], area[1]], [area[0] + list_w, area[3]], p.chrome2()).filled(true).build();
        dl.add_line([area[0] + list_w - 0.5, area[1]], [area[0] + list_w - 0.5, area[3]], p.line()).build();
        drop(dl);

        ui.set_cursor_screen_pos([area[0], area[1]]);
        let _pad = ui.push_style_var(StyleVar::WindowPadding([space::LG, space::LG]));
        ui.child_window("##ws-list")
            .size([list_w, h])
            .child_flags(ChildFlags::ALWAYS_USE_WINDOW_PADDING)
            .flags(WindowFlags::NO_SCROLLBAR | WindowFlags::NO_SCROLL_WITH_MOUSE)
            .build(ui, || self.workspace_list(ui, fonts));

        ui.set_cursor_screen_pos([area[0] + list_w, area[1]]);
        let _pad2 = ui.push_style_var(StyleVar::WindowPadding([space::XXL, space::XL]));
        ui.child_window("##ws-detail")
            .size([w - list_w, h])
            .child_flags(ChildFlags::ALWAYS_USE_WINDOW_PADDING)
            .flags(WindowFlags::NO_SCROLLBAR | WindowFlags::NO_SCROLL_WITH_MOUSE)
            .build(ui, || self.workspace_detail(ui, fonts));
    }

    fn workspace_list(&mut self, ui: &Ui, fonts: Fonts) {
        let p = self.pal;
        let names = self.engine.workspaces.list().unwrap_or_default();
        {
            let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::LG);
            ui.text("Workspaces");
        }
        ui.same_line();
        {
            let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
            let _c = ui.push_style_color(StyleColor::Text, p.dim);
            ui.text(format!("{}", names.len()));
        }
        ui.dummy([0.0, space::XS]);

        // Create: one line, Enter or the button.
        let avail = ui.content_region_avail()[0];
        if std::mem::take(&mut self.focus_new_ws) {
            ui.set_keyboard_focus_here();
        }
        let input = widgets::text_input(ui, fonts, "##new-ws", &mut self.new_ws, "New workspace", avail - space::CONTROL - space::SM, false);
        self.mark(ui, "new-ws");
        ui.same_line_with_spacing(0.0, space::SM);
        let create = widgets::icon_button(ui, fonts, "##create-ws", Icon::Plus, "Create workspace", Some("Enter"));
        self.mark(ui, "create-ws");
        if (create || input.entered) && !self.new_ws.trim().is_empty() {
            let name = self.new_ws.trim().to_owned();
            match self.engine.workspaces.create(&name, WorkspaceData::default()).and_then(|id| self.engine.workspaces.activate(id)) {
                Ok(()) => {
                    self.say(format!("Created {name}"), false);
                    self.new_ws.clear();
                }
                Err(e) => self.say(e.to_string(), true),
            }
        }
        ui.dummy([0.0, space::SM]);

        if names.is_empty() {
            widgets::note(
                ui,
                fonts,
                "A workspace is one project: its folder, Git remote, environment, terminals and commands, kept apart from every other project's.",
            );
            return;
        }

        let active = self.engine.workspaces.active().map(|w| w.name.clone());
        let rows_h = ui.content_region_avail()[1];
        let _sp = ui.push_style_var(StyleVar::ItemSpacing([0.0, 2.0]));
        let _wp = ui.push_style_var(StyleVar::WindowPadding([0.0, 0.0]));
        ui.child_window("##ws-rows").size([avail, rows_h]).build(ui, || {
            let w = ui.content_region_avail()[0];
            for name in &names {
                let is_active = active.as_deref() == Some(name.as_str());
                let open = self.engine.workspaces.open_workspaces().find(|ws| &ws.name == name).cloned();
                let pos = ui.cursor_screen_pos();
                let clicked = ui.invisible_button(format!("##wsrow-{name}"), [w, LIST_ROW_H]);
                self.mark(ui, format!("ws:{name}"));
                let hov = ui.is_item_hovered();
                let dl = ui.get_window_draw_list();
                let r1 = [pos[0] + w, pos[1] + LIST_ROW_H];
                if is_active || hov {
                    dl.add_rect(pos, r1, if is_active { p.wash() } else { p.hover() }).filled(true).rounding(6.0).build();
                }
                if is_active {
                    dl.add_rect([pos[0], pos[1] + 12.0], [pos[0] + 2.0, r1[1] - 12.0], p.acc).filled(true).build();
                }
                icons::draw(&dl, Icon::Folder, [pos[0] + 20.0, pos[1] + 18.0], 14.0, if is_active { p.acc_hi } else { p.muted });
                dl.add_text_with_font(fonts.ui_medium, size::MD, [pos[0] + 36.0, pos[1] + 10.0], p.text, name, 0.0, None);
                let sub = open.as_ref().and_then(|ws| ws.data.folder.as_ref()).map(|f| f.display().to_string()).unwrap_or_else(|| "No folder linked".into());
                let sub = {
                    let _f = ui.push_font_with_size(Some(fonts.mono), size::XS);
                    super::elide_middle(ui, &sub, w - 44.0 - 40.0)
                };
                dl.add_text_with_font(fonts.mono, size::XS, [pos[0] + 36.0, pos[1] + 29.0], p.dim, &sub, 0.0, None);
                // What it's running: terminals and commands, on the right.
                if let Some(ws) = &open {
                    let terms = self.engine.terminals.owned_by(Some(ws.id)).len();
                    let running = self.runs.iter().filter(|r| r.owner == Some(ws.id) && r.ended.is_none()).count();
                    let mut x = r1[0] - 12.0;
                    for (n, icon, c) in [(running, Icon::Run, p.acc_hi), (terms, Icon::Terminal, p.muted)] {
                        if n == 0 {
                            continue;
                        }
                        let t = n.to_string();
                        x -= 8.0 * t.len() as f32;
                        dl.add_text_with_font(fonts.ui_medium, size::XS, [x, pos[1] + 12.0], c, &t, 0.0, None);
                        x -= 14.0;
                        icons::draw(&dl, icon, [x + 5.0, pos[1] + 18.5], 11.0, c);
                        x -= 8.0;
                    }
                }
                if clicked && !is_active {
                    self.switch_workspace(name);
                }
            }
        });
    }

    fn workspace_detail(&mut self, ui: &Ui, fonts: Fonts) {
        let p = self.pal;
        let Some(ws) = self.engine.workspaces.active().cloned() else {
            {
                let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::TITLE);
                ui.text("No workspace open");
            }
            ui.dummy([0.0, space::XS]);
            widgets::note(
                ui,
                fonts,
                "Create one on the left, or pick one. Terminals and commands started without a workspace run in OXIS's own folder and environment.",
            );
            ui.dummy([0.0, space::LG]);
            if widgets::button(ui, fonts, "##home-terminal", "Open a terminal", Some(Icon::Terminal), Kind::Secondary) {
                self.open_terminal_here();
            }
            self.mark(ui, "home-terminal");
            return;
        };
        let id = ws.id;
        let width = ui.content_region_avail()[0].min(760.0);

        // The title, and the actions that matter most.
        {
            let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::TITLE);
            ui.text(&ws.name);
        }
        {
            let _f = ui.push_font_with_size(Some(fonts.mono), size::SM);
            let _c = ui.push_style_color(StyleColor::Text, p.muted);
            let folder = ws.data.folder.as_ref().map(|f| f.display().to_string()).unwrap_or_else(|| "No project folder linked yet".into());
            ui.text(super::elide_middle(ui, &folder, width));
        }
        ui.dummy([0.0, space::MD]);
        if widgets::button(ui, fonts, "##home-terminal", "Open terminal", Some(Icon::Terminal), Kind::Primary) {
            self.open_terminal_here();
        }
        self.mark(ui, "home-terminal");
        ui.same_line_with_spacing(0.0, space::SM);
        if widgets::button(ui, fonts, "##home-run", "Run a command", Some(Icon::Run), Kind::Secondary) {
            self.go(View::Run);
        }
        self.mark(ui, "home-run");
        ui.dummy([0.0, space::XL]);

        // The project folder and its Git remote.
        self.detail_section(ui, fonts, "Project folder", width);
        let hint = if cfg!(windows) { "C:\\path\\to\\project" } else { "~/path/to/project" };
        let link_w = width - 88.0;
        let input = widgets::text_input(ui, fonts, "##link", &mut self.link_path, hint, link_w, true);
        self.mark(ui, "link");
        ui.same_line_with_spacing(0.0, space::SM);
        let link = widgets::button(ui, fonts, "##link-btn", if ws.data.folder.is_some() { "Change" } else { "Link" }, None, Kind::Secondary);
        self.mark(ui, "link-btn");
        if (link || input.entered) && !self.link_path.trim().is_empty() {
            let path = expand_home(self.link_path.trim());
            match self.engine.link_folder(id, &path) {
                Ok(()) => {
                    let shown = self.engine.workspaces.get(id).and_then(|w| w.data.folder.clone()).unwrap_or(path);
                    self.say(format!("Linked to {}", shown.display()), false);
                    self.link_path.clear();
                }
                Err(e) => self.say(e.to_string(), true),
            }
        }
        ui.dummy([0.0, space::XS]);
        {
            let pos = ui.cursor_screen_pos();
            let dl = ui.get_window_draw_list();
            let (text, c) = match (&ws.data.git_remote, &ws.data.folder) {
                (Some(r), _) => (r.clone(), p.muted),
                (None, Some(_)) => ("Not a Git repository, or no remotes".to_owned(), p.dim),
                (None, None) => ("The Git remote is read from the folder".to_owned(), p.dim),
            };
            icons::draw(&dl, Icon::Branch, [pos[0] + 7.0, pos[1] + 9.0], 13.0, c);
            let text = {
                let _f = ui.push_font_with_size(Some(fonts.mono), size::SM);
                super::elide_middle(ui, &text, width - 24.0)
            };
            dl.add_text_with_font(fonts.mono, size::SM, [pos[0] + 22.0, pos[1] + 1.0], c, &text, 0.0, None);
            ui.dummy([width, 20.0]);
        }
        ui.dummy([0.0, space::LG]);

        // The environment.
        self.detail_section(ui, fonts, "Environment", width);
        let mut remove = None;
        let env_h = (ui.content_region_avail()[1] - space::CONTROL - space::LG).max(space::CONTROL);
        if ws.data.env.is_empty() {
            widgets::note(ui, fonts, "No variables. Terminals and commands in this workspace get OXIS's own environment, plus anything set here.");
            ui.dummy([0.0, space::SM]);
        } else {
            let rows = ws.data.env.len() as f32 * 30.0;
            let _wp = ui.push_style_var(StyleVar::WindowPadding([0.0, 0.0]));
            // At least one row always shows; more scroll inside the list.
            ui.child_window("##env-rows").size([width, rows.min(env_h.max(30.0))]).build(ui, || {
                for (key, value) in &ws.data.env {
                    let pos = ui.cursor_screen_pos();
                    let dl = ui.get_window_draw_list();
                    let row_hov = ui.is_mouse_hovering_rect(pos, [pos[0] + width, pos[1] + 28.0]);
                    if row_hov {
                        dl.add_rect(pos, [pos[0] + width, pos[1] + 28.0], p.hover()).filled(true).rounding(4.0).build();
                    }
                    let kw = {
                        let _f = ui.push_font_with_size(Some(fonts.mono), size::SM);
                        ui.calc_text_size(key)[0]
                    };
                    dl.add_text_with_font(fonts.mono, size::SM, [pos[0] + 8.0, pos[1] + 7.0], p.text, key, 0.0, None);
                    dl.add_text_with_font(fonts.mono, size::SM, [pos[0] + 14.0 + kw, pos[1] + 7.0], p.dim, "=", 0.0, None);
                    let shown = {
                        let _f = ui.push_font_with_size(Some(fonts.mono), size::SM);
                        super::elide_middle(ui, value, width - kw - 70.0)
                    };
                    dl.add_text_with_font(fonts.mono, size::SM, [pos[0] + 28.0 + kw, pos[1] + 7.0], p.acc_hi, &shown, 0.0, None);
                    drop(dl);
                    ui.set_cursor_screen_pos([pos[0] + width - space::CONTROL, pos[1]]);
                    if widgets::icon_button(ui, fonts, &format!("##env-rm-{key}"), Icon::Trash, &format!("Remove {key}"), None) {
                        remove = Some(key.clone());
                    }
                    self.mark(ui, format!("env-rm:{key}"));
                    ui.set_cursor_screen_pos([pos[0], pos[1] + 30.0]);
                }
                // An item after moving the cursor, so the child grows to fit.
                ui.dummy([0.0, 0.0]);
            });
            ui.dummy([0.0, space::XS]);
        }
        if let Some(key) = remove {
            match self.engine.set_env(id, &key, None) {
                Ok(()) => self.say(format!("Removed {key}"), false),
                Err(e) => self.say(e.to_string(), true),
            }
        }
        let input = widgets::text_input(ui, fonts, "##env", &mut self.env_line, "NAME=value", width - 88.0, true);
        self.mark(ui, "env");
        ui.same_line_with_spacing(0.0, space::SM);
        let add = widgets::button(ui, fonts, "##env-set", "Set", None, Kind::Secondary);
        self.mark(ui, "env-set");
        if (add || input.entered) && !self.env_line.trim().is_empty() {
            match oxide::workspace::parse_env_assignment(&self.env_line).and_then(|(k, v)| self.engine.set_env(id, &k, Some(&v)).map(|()| k)) {
                Ok(k) => {
                    self.say(format!("Set {k} for {}", ws.name), false);
                    self.env_line.clear();
                }
                Err(e) => self.say(e.to_string(), true),
            }
        }
    }

    /// A section heading in the detail column: the title, a hairline.
    fn detail_section(&self, ui: &Ui, fonts: Fonts, title: &str, width: f32) {
        let p = self.pal;
        {
            let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::MD);
            ui.text(title);
        }
        let pos = ui.cursor_screen_pos();
        ui.get_window_draw_list().add_line([pos[0], pos[1] + 2.0], [pos[0] + width, pos[1] + 2.0], alpha(p.text, 0.07)).build();
        ui.dummy([0.0, space::MD]);
    }

    /// Opens a new terminal in the active workspace and shows it.
    fn open_terminal_here(&mut self) {
        self.go(View::Terminal);
        self.open_terminal_tab();
    }
}
