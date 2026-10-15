//! The OXIS interface: title bar, sidebar, views and status bar, drawn
//! over the engine.
//!
//! The frame is one borderless ImGui window covering the OS window. Most
//! chrome is drawn directly with the draw list (so it looks like OXIS, not
//! like ImGui); scrolling content uses child windows. Nothing here holds
//! engine state of its own beyond what's on screen: workspaces and
//! processes are read from the engine every frame, and process output
//! arrives through the engine's event bus.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::Instant;

use crossbeam_channel::{unbounded, Receiver, Sender};
use dear_imgui_rs::{Condition, Context, MouseButton, MouseCursor, StyleColor, Ui, WindowFlags};
use oxide::events::{Event, Stream};
use oxide::ids::{ProcessId, WorkspaceId};
use oxide::process::{ProcessSpec, Status};
use oxide::workspace::WorkspaceData;
use oxide::Engine;
use winit::event_loop::EventLoopProxy;
use winit::window::{ResizeDirection, Window};

use crate::theme::{self, col, size, Fonts, Palette};
use crate::window_state::{self, WindowState};
use crate::Wake;

const TITLE_H: f32 = 40.0;
const SIDEBAR_W: f32 = 56.0;
const STATUS_H: f32 = 24.0;
const PROMPT_H: f32 = 44.0;
const EDGE: f32 = 5.0;
/// Lines kept per command; older ones are dropped (and counted).
const RUN_LINES: usize = 5000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Home,
    Run,
    Settings,
}

struct Run {
    id: ProcessId,
    /// The workspace it was started in; the Run view shows only the active
    /// workspace's commands.
    owner: Option<WorkspaceId>,
    command: String,
    started: Instant,
    ended: Option<(Instant, Status)>,
    lines: VecDeque<(Stream, String)>,
    dropped: usize,
}

/// What the frame asks of the window after it's drawn.
#[derive(Default)]
pub struct FrameActions {
    pub quit: bool,
    pub animating: bool,
}

pub struct Shell {
    engine: Engine,
    pal: Palette,
    fonts: Option<Fonts>,
    window_state: WindowState,
    tx: Sender<Event>,
    rx: Receiver<Event>,
    view: View,
    runs: Vec<Run>,
    cmd: String,
    focus_cmd: bool,
    new_ws: String,
    link_path: String,
    notice: Option<(String, bool, Instant)>,
    dragging_title: bool,
    /// Where each named control was drawn this frame, for `--drive`
    /// scripts to click by name.
    hotspots: HashMap<String, [f32; 4]>,
    /// The `NAME=value` being typed in the Project panel.
    env_line: String,
    focus_new_ws: bool,
}

impl Shell {
    pub fn new(engine: Engine) -> Self {
        let window_state = oxide::config::load::<WindowState>(&engine.data_dir().join("window.json")).map(|l| l.value).unwrap_or_default();
        let (tx, rx) = unbounded();
        let mut shell = Self {
            engine,
            pal: Palette::default(),
            fonts: None,
            window_state,
            tx,
            rx,
            view: View::Home,
            runs: Vec::new(),
            cmd: String::new(),
            focus_cmd: false,
            new_ws: String::new(),
            link_path: String::new(),
            notice: None,
            dragging_title: false,
            hotspots: HashMap::new(),
            env_line: String::new(),
            focus_new_ws: false,
        };
        shell.restore_workspace();
        shell
    }

    /// Opens a view by name (`home`, `run`, `settings`), for `--view=`.
    pub fn set_view(&mut self, name: &str) {
        self.view = match name {
            "run" => View::Run,
            "settings" => View::Settings,
            _ => View::Home,
        };
        self.focus_cmd = self.view == View::Run;
    }

    /// The screen rectangle a named control was drawn at last frame.
    pub fn hotspot(&self, name: &str) -> Option<[f32; 4]> {
        self.hotspots.get(name).copied()
    }

    fn active_id(&self) -> Option<WorkspaceId> {
        self.engine.workspaces.active().map(|w| w.id)
    }

    /// How many of the active workspace's commands are still running.
    pub fn running(&self) -> usize {
        let here = self.active_id();
        self.runs.iter().filter(|r| r.ended.is_none() && r.owner == here).count()
    }

    /// Whether the active workspace's latest command has printed `line`.
    pub fn latest_output_has(&self, line: &str) -> bool {
        let here = self.active_id();
        self.runs.iter().rev().find(|r| r.owner == here).is_some_and(|r| r.lines.iter().any(|(_, l)| l.trim() == line))
    }

    /// What's on screen and in the engine, as JSON (for `--drive` tests).
    pub fn dump(&self) -> serde_json::Value {
        let ws = |w: &oxide::workspace::Workspace| serde_json::json!({ "name": w.name, "folder": w.data.folder, "git_remote": w.data.git_remote, "env": w.data.env });
        let mut open: Vec<_> = self.engine.workspaces.open_workspaces().map(ws).collect();
        open.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        serde_json::json!({
            "view": match self.view { View::Home => "home", View::Run => "run", View::Settings => "settings" },
            "active": self.engine.workspaces.active().map(ws),
            "open": open,
            "on_disk": self.engine.workspaces.list().unwrap_or_default(),
            "settings": { "shell": self.engine.settings.shell, "restore_session": self.engine.settings.restore_session },
            "notice": self.notice.as_ref().map(|n| serde_json::json!({ "text": n.0, "error": n.1 })),
            "runs": self.runs.iter().map(|r| {
                let owner = r.owner.and_then(|id| self.engine.workspaces.get(id)).map(|w| w.name.clone());
                let (status, code, cancelled) = match r.ended {
                    None => ("running", None, false),
                    Some((_, Status::Exited { code, cancelled })) => ("exited", code, cancelled),
                    Some((_, Status::Running)) => ("running", None, false),
                };
                serde_json::json!({
                    "command": r.command, "workspace": owner, "visible": r.owner == self.active_id(), "status": status, "code": code, "cancelled": cancelled,
                    "stdout": r.lines.iter().filter(|(s, _)| *s == Stream::Stdout).map(|(_, l)| l).collect::<Vec<_>>(),
                    "stderr": r.lines.iter().filter(|(s, _)| *s == Stream::Stderr).map(|(_, l)| l).collect::<Vec<_>>(),
                })
            }).collect::<Vec<_>>(),
        })
    }

    fn mark(&mut self, ui: &Ui, name: impl Into<String>) {
        let (a, b) = (ui.item_rect_min(), ui.item_rect_max());
        self.hotspots.insert(name.into(), [a[0], a[1], b[0], b[1]]);
    }

    pub fn window_state(&self) -> &WindowState {
        &self.window_state
    }

    /// Fonts and style, once the ImGui context exists.
    pub fn setup_imgui(&mut self, ctx: &mut Context) {
        self.fonts = Some(theme::load_fonts(ctx));
        theme::apply_style(ctx, &self.pal);
    }

    /// Forwards engine events to the UI and wakes the window for each.
    pub fn start_event_pump(&self, proxy: EventLoopProxy<Wake>) {
        let bus_rx = self.engine.bus.subscribe();
        let tx = self.tx.clone();
        std::thread::Builder::new()
            .name("ui-events".into())
            .spawn(move || {
                for ev in bus_rx {
                    if tx.send(ev).is_err() || proxy.send_event(Wake).is_err() {
                        break;
                    }
                }
            })
            .expect("couldn't start the UI event thread");
    }

    /// Applies engine events that arrived since the last frame.
    pub fn drain_events(&mut self) {
        while let Ok(ev) = self.rx.try_recv() {
            match ev {
                Event::ProcessOutput { id, stream, line } => {
                    if let Some(run) = self.runs.iter_mut().find(|r| r.id == id) {
                        if run.lines.len() == RUN_LINES {
                            run.lines.pop_front();
                            run.dropped += 1;
                        }
                        run.lines.push_back((stream, line));
                    }
                }
                Event::ProcessExited { id, code, cancelled } => {
                    if let Some(run) = self.runs.iter_mut().find(|r| r.id == id) {
                        run.ended = Some((Instant::now(), Status::Exited { code, cancelled }));
                    }
                }
                _ => {}
            }
        }
    }

    pub fn save_window(&mut self, window: &Window) {
        self.window_state = window_state::capture(window, &self.window_state);
        if let Err(e) = oxide::config::save(&self.engine.data_dir().join("window.json"), &self.window_state) {
            tracing::warn!("couldn't remember the window's place: {e}");
        }
    }

    /// Stops what's still running and (when `persist`) remembers the
    /// active workspace.
    pub fn shutdown(&mut self, persist: bool) {
        for p in self.engine.processes.list() {
            if p.status == Status::Running {
                let _ = self.engine.processes.cancel(p.id);
            }
        }
        if persist {
            self.engine.settings.last_workspace = self.engine.workspaces.active().map(|w| w.name.clone());
            if let Err(e) = self.engine.save_settings() {
                tracing::warn!("couldn't save the settings on the way out: {e}");
            }
        }
    }

    fn restore_workspace(&mut self) {
        if !self.engine.settings.restore_session {
            return;
        }
        if let Some(name) = self.engine.settings.last_workspace.clone() {
            if let Ok(id) = self.engine.workspaces.open(&name) {
                let _ = self.engine.workspaces.activate(id);
            }
        }
    }

    fn say(&mut self, text: impl Into<String>, error: bool) {
        self.notice = Some((text.into(), error, Instant::now()));
    }

    // ── the frame ──────────────────────────────────────────────────────

    pub fn draw(&mut self, ui: &Ui, window: &Window) -> FrameActions {
        let mut actions = FrameActions::default();
        let Some(fonts) = self.fonts else {
            return actions;
        };
        let display = ui.io().display_size();
        let _font = ui.push_font_with_size(Some(fonts.ui), size::MD);
        self.hotspots.clear();

        ui.window("##oxis")
            .position([0.0, 0.0], Condition::Always)
            .size(display, Condition::Always)
            .flags(
                WindowFlags::NO_DECORATION
                    | WindowFlags::NO_MOVE
                    | WindowFlags::NO_SAVED_SETTINGS
                    | WindowFlags::NO_BRING_TO_FRONT_ON_FOCUS
                    | WindowFlags::NO_SCROLL_WITH_MOUSE,
            )
            .build(|| {
                self.title_bar(ui, window, fonts, display, &mut actions);
                self.sidebar(ui, fonts, display);
                let content = [SIDEBAR_W, TITLE_H, display[0], display[1] - STATUS_H];
                match self.view {
                    View::Home => self.home(ui, fonts, content),
                    View::Run => self.run_view(ui, fonts, content),
                    View::Settings => self.settings(ui, fonts, content),
                }
                self.status_bar(ui, fonts, display);
                self.notice_toast(ui, fonts, display, &mut actions);
                self.resize_edges(ui, window, display);
            });
        actions
    }

    fn title_bar(&mut self, ui: &Ui, window: &Window, fonts: Fonts, display: [f32; 2], actions: &mut FrameActions) {
        let p = self.pal;
        let dl = ui.get_window_draw_list();
        dl.add_rect([0.0, 0.0], [display[0], TITLE_H], col(p.chrome())).filled(true).build();
        dl.add_line([0.0, TITLE_H - 0.5], [display[0], TITLE_H - 0.5], col(p.line())).build();

        // The mark and the word.
        let c = [24.0, TITLE_H / 2.0];
        dl.add_circle(c, 7.5, col(p.acc_lo)).thickness(3.6).build();
        dl.add_circle(c, 7.5, col(theme::alpha(p.acc_hi, 0.65))).thickness(1.2).build();
        spaced_text(ui, &dl, fonts.mono_bold, size::SM, [42.0, TITLE_H / 2.0 - 8.0], col(p.text), "OXIS", 2.4);
        dl.add_line([96.0, 8.0], [96.0, TITLE_H - 8.0], col(p.line())).build();

        // The workspace switcher.
        let label = self.engine.workspaces.active().map(|w| w.name.clone()).unwrap_or_else(|| "No workspace".into());
        let lw = ui.calc_text_size(&label)[0];
        let chip = [108.0, 8.0, 108.0 + lw + 46.0, TITLE_H - 8.0];
        ui.set_cursor_screen_pos([chip[0], chip[1]]);
        if ui.invisible_button("##ws-switch", [chip[2] - chip[0], chip[3] - chip[1]]) {
            ui.open_popup("ws-menu");
        }
        self.mark(ui, "ws-switch");
        let hovered = ui.is_item_hovered();
        dl.add_rect([chip[0], chip[1]], [chip[2], chip[3]], col(if hovered { p.press() } else { p.hover() })).filled(true).rounding(5.0).build();
        let dot = if self.engine.workspaces.active().is_some() { p.acc } else { p.dim };
        dl.add_circle([chip[0] + 13.0, TITLE_H / 2.0], 3.2, col(dot)).filled(true).build();
        dl.add_text_with_font(fonts.ui_medium, size::SM, [chip[0] + 24.0, TITLE_H / 2.0 - 8.0], col(p.text), &label, 0.0, None);
        chevron(&dl, [chip[2] - 13.0, TITLE_H / 2.0], col(p.muted));
        self.workspace_menu(ui, fonts);

        // Window controls, right to left.
        let bw = 46.0;
        let mut x = display[0] - bw;
        for (i, kind) in [Icon::Close, if window.is_maximized() { Icon::Restore } else { Icon::Maximize }, Icon::Minimize].into_iter().enumerate() {
            ui.set_cursor_screen_pos([x, 0.0]);
            let clicked = ui.invisible_button(format!("##win{i}"), [bw, TITLE_H - 1.0]);
            self.mark(ui, ["win:close", "win:max", "win:min"][i]);
            let hov = ui.is_item_hovered();
            if hov {
                let bg = if kind == Icon::Close { [0.84, 0.23, 0.23, 1.0] } else { p.hover() };
                dl.add_rect([x, 0.0], [x + bw, TITLE_H - 1.0], col(bg)).filled(true).build();
            }
            let ic = if hov && kind == Icon::Close { [1.0, 1.0, 1.0, 1.0] } else { p.muted };
            draw_icon(&dl, kind, [x + bw / 2.0, TITLE_H / 2.0], 10.0, col(ic));
            if clicked {
                match kind {
                    Icon::Close => actions.quit = true,
                    Icon::Minimize => window.set_minimized(true),
                    _ => window.set_maximized(!window.is_maximized()),
                }
            }
            x -= bw;
        }

        // The rest of the bar moves the window; a double click maximises.
        let drag_x = chip[2] + 8.0;
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

    fn workspace_menu(&mut self, ui: &Ui, fonts: Fonts) {
        // Style that shapes the popup window must be pushed before it begins.
        // (It stays pushed until the popup ends: tokens drop in reverse order.)
        let _pad = ui.push_style_var(dear_imgui_rs::StyleVar::WindowPadding([10.0, 8.0]));
        let Some(_popup) = ui.begin_popup("ws-menu") else {
            return;
        };
        ui.text_disabled("WORKSPACES");
        let names = self.engine.workspaces.list().unwrap_or_default();
        let active = self.engine.workspaces.active().map(|w| w.name.clone());
        if names.is_empty() {
            ui.text_disabled("none yet");
        }
        for name in names {
            let is_active = active.as_deref() == Some(&name);
            let _c = is_active.then(|| ui.push_style_color(StyleColor::Text, self.pal.acc_hi));
            let picked = ui.selectable_config(format!("    {name}")).build();
            self.mark(ui, format!("ws-menu:{name}"));
            if is_active {
                let (a, b) = (ui.item_rect_min(), ui.item_rect_max());
                ui.get_window_draw_list().add_circle([a[0] + 6.0, (a[1] + b[1]) / 2.0], 3.2, col(self.pal.acc)).filled(true).build();
            }
            if picked {
                match self.engine.workspaces.open(&name).and_then(|id| self.engine.workspaces.activate(id)) {
                    Ok(()) => self.say(format!("Switched to {name}"), false),
                    Err(e) => self.say(e.to_string(), true),
                }
            }
        }
        ui.separator();
        let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
        if ui.selectable("New workspace…") {
            self.view = View::Home;
            self.focus_new_ws = true;
        }
    }

    fn sidebar(&mut self, ui: &Ui, fonts: Fonts, display: [f32; 2]) {
        let p = self.pal;
        let dl = ui.get_window_draw_list();
        let (top, bottom) = (TITLE_H, display[1] - STATUS_H);
        dl.add_rect([0.0, top], [SIDEBAR_W, bottom], col(p.chrome())).filled(true).build();
        dl.add_line([SIDEBAR_W - 0.5, top], [SIDEBAR_W - 0.5, bottom], col(p.line())).build();

        let items = [(View::Home, Icon::Home, "Home"), (View::Run, Icon::Terminal, "Run"), (View::Settings, Icon::Gear, "Settings")];
        for (i, (view, icon, name)) in items.into_iter().enumerate() {
            let y = if view == View::Settings { bottom - 52.0 } else { top + 10.0 + i as f32 * 48.0 };
            ui.set_cursor_screen_pos([6.0, y]);
            let clicked = ui.invisible_button(format!("##nav{i}"), [SIDEBAR_W - 12.0, 42.0]);
            self.mark(ui, format!("nav:{}", name.to_lowercase()));
            if clicked {
                self.view = view;
                if view == View::Run {
                    self.focus_cmd = true;
                }
            }
            let hov = ui.is_item_hovered();
            let on = self.view == view;
            if on || hov {
                dl.add_rect([6.0, y], [SIDEBAR_W - 6.0, y + 42.0], col(if on { p.wash() } else { p.hover() })).filled(true).rounding(6.0).build();
            }
            if on {
                dl.add_rect([0.0, y + 9.0], [2.5, y + 33.0], col(p.acc)).filled(true).rounding(2.0).build();
            }
            draw_icon(
                &dl,
                icon,
                [SIDEBAR_W / 2.0, y + 21.0],
                16.0,
                col(if on {
                    p.acc_hi
                } else if hov {
                    p.text
                } else {
                    p.muted
                }),
            );
            if hov {
                let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
                ui.tooltip_text(name);
            }
        }
    }

    fn status_bar(&self, ui: &Ui, fonts: Fonts, display: [f32; 2]) {
        let p = self.pal;
        let dl = ui.get_window_draw_list();
        let y = display[1] - STATUS_H;
        dl.add_rect([0.0, y], [display[0], display[1]], col(p.chrome())).filled(true).build();
        dl.add_line([0.0, y + 0.5], [display[0], y + 0.5], col(p.line())).build();
        let mid = y + STATUS_H / 2.0;
        let text_y = mid - 7.0;

        let mode = match self.view {
            View::Home => "HOME",
            View::Run => "RUN",
            View::Settings => "SETTINGS",
        };
        let mut x = 10.0;
        dl.add_rect([x, mid - 3.5], [x + 7.0, mid + 3.5], col(p.acc)).filled(true).rounding(1.0).build();
        x += 14.0;
        spaced_text(ui, &dl, fonts.ui_semibold, size::XS - 0.5, [x, text_y + 1.0], col(p.text), mode, 1.0);
        x += 74.0;
        let seg = |x: &mut f32, text: &str, c: theme::Rgba| {
            dl.add_line([*x, y + 4.0], [*x, display[1] - 4.0], col(p.line())).build();
            dl.add_text_with_font(fonts.ui, size::XS, [*x + 10.0, text_y + 1.0], col(c), text, 0.0, None);
            *x += ui.calc_text_size(text)[0] * size::XS / size::MD + 22.0;
        };
        let ws = self.engine.workspaces.active().map(|w| w.name.clone()).unwrap_or_else(|| "no workspace".into());
        seg(&mut x, &ws, p.muted);
        let running = self.runs.iter().filter(|r| r.ended.is_none()).count();
        if running > 0 {
            seg(&mut x, &format!("{running} running"), p.acc_hi);
        }

        let right = format!("OXIS {}", oxide::VERSION);
        let rw = ui.calc_text_size(&right)[0] * size::XS / size::MD;
        dl.add_text_with_font(fonts.mono, size::XS - 0.5, [display[0] - rw - 14.0, text_y + 1.0], col(p.dim), &right, 0.0, None);
    }

    fn notice_toast(&mut self, ui: &Ui, fonts: Fonts, display: [f32; 2], actions: &mut FrameActions) {
        let Some((text, error, at)) = &self.notice else {
            return;
        };
        let age = at.elapsed().as_secs_f32();
        if age > 3.5 {
            self.notice = None;
            return;
        }
        actions.animating = true;
        let p = self.pal;
        let fade = (1.0 - ((age - 3.0) / 0.5).max(0.0)).min(1.0);
        let dl = ui.get_foreground_draw_list();
        let w = ui.calc_text_size(text)[0] + 36.0;
        let x = (display[0] - w) / 2.0;
        let y = display[1] - STATUS_H - 56.0;
        dl.add_rect([x, y], [x + w, y + 34.0], col(theme::alpha(p.overlay(), fade))).filled(true).rounding(6.0).build();
        dl.add_rect([x, y], [x + w, y + 34.0], col(theme::alpha(p.text, 0.16 * fade))).rounding(6.0).build();
        let c = if *error { p.err } else { p.text };
        dl.add_text_with_font(fonts.ui, size::MD, [x + 18.0, y + 8.0], col(theme::alpha(c, fade)), text, 0.0, None);
    }

    fn resize_edges(&self, ui: &Ui, window: &Window, display: [f32; 2]) {
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

    // ── views ──────────────────────────────────────────────────────────

    fn home(&mut self, ui: &Ui, fonts: Fonts, area: [f32; 4]) {
        let p = self.pal;
        ui.set_cursor_screen_pos([area[0], area[1]]);
        let _pad = ui.push_style_var(dear_imgui_rs::StyleVar::WindowPadding([32.0, 26.0]));
        ui.child_window("##home")
            .size([area[2] - area[0], area[3] - area[1]])
            .child_flags(dear_imgui_rs::ChildFlags::ALWAYS_USE_WINDOW_PADDING)
            .flags(WindowFlags::NO_SCROLLBAR | WindowFlags::NO_SCROLL_WITH_MOUSE)
            .build(ui, || {
                let active = self.engine.workspaces.active().cloned();
                eyebrow(ui, fonts, &p, "WORKSPACE", active.is_some());
                {
                    let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::TITLE);
                    ui.text(active.as_ref().map(|w| w.name.as_str()).unwrap_or("No workspace open"));
                }
                {
                    let _f = ui.push_font_with_size(Some(fonts.ui), size::MD);
                    let _c = ui.push_style_color(StyleColor::Text, p.muted);
                    let room = ui.content_region_avail()[0];
                    match &active {
                        Some(w) => ui.text(match &w.data.folder {
                            Some(f) => elide_middle(ui, &format!("Linked to {}", f.display()), room),
                            None => "Not linked to a project folder yet.".to_owned(),
                        }),
                        None => ui.text("Create a workspace for a project, or open one below."),
                    }
                }
                ui.dummy([0.0, 14.0]);

                let half = (ui.content_region_avail()[0] - 16.0) / 2.0;
                let tall = (ui.content_region_avail()[1] - 2.0).clamp(120.0, 420.0);
                panel(ui, fonts, &p, "Workspaces", half, tall, || {
                    let names = self.engine.workspaces.list().unwrap_or_default();
                    if names.is_empty() {
                        let _c = ui.push_style_color(StyleColor::Text, p.dim);
                        ui.text("No workspaces yet.");
                    }
                    let active_name = active.as_ref().map(|w| w.name.clone());
                    for name in &names {
                        let is_active = active_name.as_deref() == Some(name.as_str());
                        let _c = ui.push_style_color(StyleColor::Text, if is_active { p.acc_hi } else { p.text });
                        let _f = ui.push_font_with_size(Some(fonts.mono), size::MD);
                        let picked = ui.selectable_config(format!("{}  {name}", if is_active { "●" } else { "○" })).selected(is_active).build();
                        self.mark(ui, format!("ws:{name}"));
                        if picked && !is_active {
                            match self.engine.workspaces.open(name).and_then(|id| self.engine.workspaces.activate(id)) {
                                Ok(()) => self.say(format!("Switched to {name}"), false),
                                Err(e) => self.say(e.to_string(), true),
                            }
                        }
                    }
                    ui.dummy([0.0, 8.0]);
                    ui.set_next_item_width(ui.content_region_avail()[0] - 84.0);
                    if std::mem::take(&mut self.focus_new_ws) {
                        ui.set_keyboard_focus_here();
                    }
                    let enter = ui.input_text("##new-ws", &mut self.new_ws).hint("New workspace name").enter_returns_true(true).build();
                    self.mark(ui, "new-ws");
                    ui.same_line();
                    let create = button(ui, "Create", true);
                    self.mark(ui, "create-ws");
                    if (create || enter) && !self.new_ws.trim().is_empty() {
                        let name = self.new_ws.trim().to_owned();
                        match self.engine.workspaces.create(&name, WorkspaceData::default()).and_then(|id| self.engine.workspaces.activate(id)) {
                            Ok(()) => {
                                self.say(format!("Created {name}"), false);
                                self.new_ws.clear();
                            }
                            Err(e) => self.say(e.to_string(), true),
                        }
                    }
                });
                ui.same_line_with_spacing(0.0, 16.0);
                panel(ui, fonts, &p, "Project", half, tall, || {
                    let Some(ws) = &active else {
                        let _c = ui.push_style_color(StyleColor::Text, p.dim);
                        ui.text_wrapped("Open a workspace to link it to a project folder.");
                        return;
                    };
                    let id = ws.id;
                    ui.set_next_item_width(ui.content_region_avail()[0] - 72.0);
                    let hint = if cfg!(windows) { "C:\\path\\to\\project" } else { "~/path/to/project" };
                    let enter = ui.input_text("##link", &mut self.link_path).hint(hint).enter_returns_true(true).build();
                    self.mark(ui, "link");
                    ui.same_line();
                    let link = button(ui, "Link", true);
                    self.mark(ui, "link-btn");
                    if (link || enter) && !self.link_path.trim().is_empty() {
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
                    {
                        let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
                        let _c = ui.push_style_color(StyleColor::Text, p.muted);
                        let room = ui.content_region_avail()[0];
                        ui.text(match &ws.data.git_remote {
                            Some(r) => elide_middle(ui, &format!("Git remote  {r}"), room),
                            None if ws.data.folder.is_some() => "Git remote  none (not a Git repository, or no remotes)".to_owned(),
                            None => "Git remote  link a folder to detect it".to_owned(),
                        });
                    }
                    ui.dummy([0.0, 6.0]);
                    {
                        let _f = ui.push_font_with_size(Some(fonts.ui_semibold), size::SM);
                        ui.text("Environment");
                    }
                    let mut remove = None;
                    if ws.data.env.is_empty() {
                        let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
                        let _c = ui.push_style_color(StyleColor::Text, p.dim);
                        ui.text("No variables. Commands get OXIS's own environment.");
                    }
                    for (key, value) in &ws.data.env {
                        let _id = ui.push_id(key.as_str());
                        let _f = ui.push_font_with_size(Some(fonts.mono), size::SM);
                        if ui.small_button("×") {
                            remove = Some(key.clone());
                        }
                        self.mark(ui, format!("env-rm:{key}"));
                        ui.same_line();
                        ui.text(format!("{key}={value}"));
                    }
                    if let Some(key) = remove {
                        match self.engine.set_env(id, &key, None) {
                            Ok(()) => self.say(format!("Removed {key}"), false),
                            Err(e) => self.say(e.to_string(), true),
                        }
                    }
                    ui.set_next_item_width(ui.content_region_avail()[0] - 72.0);
                    let enter = ui.input_text("##env", &mut self.env_line).hint("NAME=value").enter_returns_true(true).build();
                    self.mark(ui, "env");
                    ui.same_line();
                    let add = button(ui, "Set", false);
                    self.mark(ui, "env-set");
                    if (add || enter) && !self.env_line.trim().is_empty() {
                        match oxide::workspace::parse_env_assignment(&self.env_line).and_then(|(k, v)| self.engine.set_env(id, &k, Some(&v)).map(|()| k)) {
                            Ok(k) => {
                                self.say(format!("Set {k} for {}", ws.name), false);
                                self.env_line.clear();
                            }
                            Err(e) => self.say(e.to_string(), true),
                        }
                    }
                });
            });
    }

    fn run_view(&mut self, ui: &Ui, fonts: Fonts, area: [f32; 4]) {
        let p = self.pal;
        let out_h = area[3] - area[1] - PROMPT_H;
        ui.set_cursor_screen_pos([area[0], area[1]]);
        let _pad = ui.push_style_var(dear_imgui_rs::StyleVar::WindowPadding([20.0, 14.0]));
        let mut cancel = None;
        let mut stops: Vec<(String, [f32; 4])> = Vec::new();
        ui.child_window("##runs")
            .size([area[2] - area[0], out_h])
            .child_flags(dear_imgui_rs::ChildFlags::ALWAYS_USE_WINDOW_PADDING)
            .flags(WindowFlags::HORIZONTAL_SCROLLBAR)
            .build(ui, || {
                let here = self.active_id();
                if !self.runs.iter().any(|r| r.owner == here) {
                    let _c = ui.push_style_color(StyleColor::Text, p.dim);
                    ui.text(format!("Type a command below. Each line runs as its own process in {}.", self.shell_label()));
                }
                let at_bottom = ui.scroll_y() >= ui.scroll_max_y() - 4.0;
                for (index, run) in self.runs.iter().filter(|r| r.owner == here).enumerate() {
                    let _id = ui.push_id(run.id.raw() as i32);
                    {
                        let _f = ui.push_font_with_size(Some(fonts.mono_bold), size::MD);
                        let _c = ui.push_style_color(StyleColor::Text, p.acc_hi);
                        ui.text(format!("❯ {}", run.command));
                    }
                    ui.same_line();
                    let (label, c) = match run.ended {
                        None => (format!("running · {:.0}s", run.started.elapsed().as_secs_f32()), p.muted),
                        Some((t, st)) => {
                            let secs = (t - run.started).as_secs_f32();
                            match st {
                                Status::Exited { cancelled: true, .. } => (format!("stopped · {secs:.1}s"), p.warn),
                                Status::Exited { code: Some(0), .. } => (format!("✓ · {secs:.1}s"), p.ok),
                                Status::Exited { code, .. } => (format!("exit {} · {secs:.1}s", code.map(|c| c.to_string()).unwrap_or("?".into())), p.err),
                                Status::Running => (String::new(), p.muted),
                            }
                        }
                    };
                    {
                        let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
                        let _c = ui.push_style_color(StyleColor::Text, c);
                        ui.text(label);
                    }
                    if run.ended.is_none() {
                        ui.same_line();
                        let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
                        if ui.small_button("Stop") {
                            cancel = Some(run.id);
                        }
                        let (a, b) = (ui.item_rect_min(), ui.item_rect_max());
                        stops.push((format!("stop:{index}"), [a[0], a[1], b[0], b[1]]));
                    }
                    let _f = ui.push_font_with_size(Some(fonts.mono), size::MD);
                    if run.dropped > 0 {
                        let _c = ui.push_style_color(StyleColor::Text, p.dim);
                        ui.text(format!("… {} earlier lines not kept", run.dropped));
                    }
                    for (stream, line) in &run.lines {
                        let _c = ui.push_style_color(StyleColor::Text, if *stream == Stream::Stderr { p.err } else { p.text });
                        ui.text(line);
                    }
                    ui.dummy([0.0, 8.0]);
                }
                if at_bottom {
                    ui.set_scroll_here_y(1.0);
                }
            });
        self.hotspots.extend(stops);
        // Ctrl+C with nothing typed stops the latest command still running.
        if cancel.is_none() && self.cmd.is_empty() && ui.io().key_ctrl() && ui.is_key_pressed(dear_imgui_rs::Key::C) {
            let here = self.active_id();
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
        dl.add_rect([area[0], y], [area[2], area[3]], col(p.chrome2())).filled(true).build();
        dl.add_line([area[0], y], [area[2], y], col(p.line2())).build();
        dl.add_text_with_font(fonts.mono_bold, size::MD, [area[0] + 18.0, y + PROMPT_H / 2.0 - 9.0], col(p.acc), "OXIS ❯", 0.0, None);
        ui.set_cursor_screen_pos([area[0] + 82.0, y + (PROMPT_H - 28.0) / 2.0]);
        ui.set_next_item_width(area[2] - area[0] - 100.0);
        if self.focus_cmd {
            ui.set_keyboard_focus_here();
            self.focus_cmd = false;
        }
        let _f = ui.push_font_with_size(Some(fonts.mono), size::MD);
        let _bg = ui.push_style_color(StyleColor::FrameBg, [0.0; 4]);
        let _bd = ui.push_style_color(StyleColor::Border, [0.0; 4]);
        let entered = ui.input_text("##cmd", &mut self.cmd).enter_returns_true(true).build();
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

    fn settings(&mut self, ui: &Ui, fonts: Fonts, area: [f32; 4]) {
        let p = self.pal;
        ui.set_cursor_screen_pos([area[0], area[1]]);
        let _pad = ui.push_style_var(dear_imgui_rs::StyleVar::WindowPadding([32.0, 26.0]));
        ui.child_window("##settings").size([area[2] - area[0], area[3] - area[1]]).child_flags(dear_imgui_rs::ChildFlags::ALWAYS_USE_WINDOW_PADDING).build(
            ui,
            || {
                {
                    let _f = ui.push_font_with_size(Some(fonts.ui_semibold), 22.0);
                    ui.text("Settings");
                }
                {
                    let _c = ui.push_style_color(StyleColor::Text, p.muted);
                    let room = ui.content_region_avail()[0];
                    ui.text(elide_middle(ui, &format!("Saved to {}", self.engine.data_dir().join("settings.json").display()), room));
                }
                ui.dummy([0.0, 12.0]);
                let mut changed = false;
                setting_row(ui, fonts, &p, "Shell", "The shell commands run in. Auto picks PowerShell on Windows and your $SHELL elsewhere.", || {
                    let choices: &[&str] = if cfg!(windows) { &["auto", "powershell", "pwsh", "cmd"] } else { &["auto", "sh", "bash", "zsh", "fish"] };
                    ui.set_next_item_width(180.0);
                    if let Some(_combo) = ui.begin_combo("##shell", &self.engine.settings.shell) {
                        for c in choices {
                            if ui.selectable_config(*c).selected(self.engine.settings.shell == *c).build() {
                                self.engine.settings.shell = (*c).to_owned();
                                changed = true;
                            }
                        }
                    }
                });
                setting_row(ui, fonts, &p, "Restore session", "Reopen the workspace you were in when OXIS starts.", || {
                    changed |= ui.checkbox("##restore", &mut self.engine.settings.restore_session);
                });
                if changed {
                    match self.engine.save_settings() {
                        Ok(()) => self.say("Saved", false),
                        Err(e) => self.say(e.to_string(), true),
                    }
                }
            },
        );
    }

    // ── running commands ───────────────────────────────────────────────

    fn shell_label(&self) -> String {
        let (program, _) = self.shell_program();
        program
    }

    fn shell_program(&self) -> (String, Vec<String>) {
        let pick = self.engine.settings.shell.as_str();
        if cfg!(windows) {
            match pick {
                "cmd" => ("cmd".into(), vec!["/D".into(), "/S".into(), "/C".into()]),
                "pwsh" => ("pwsh".into(), vec!["-NoLogo".into(), "-NonInteractive".into(), "-Command".into()]),
                _ => ("powershell".into(), vec!["-NoLogo".into(), "-NonInteractive".into(), "-Command".into()]),
            }
        } else {
            let sh = match pick {
                "auto" => std::env::var("SHELL").unwrap_or_else(|_| "sh".into()),
                other => other.to_owned(),
            };
            (sh, vec!["-c".into()])
        }
    }

    fn start_run(&mut self, line: String) {
        let (program, mut args) = self.shell_program();
        args.push(line.clone());
        let spec = ProcessSpec { program, args, ..Default::default() };
        let owner = self.active_id();
        let result = match owner {
            Some(ws) => self.engine.spawn_in(ws, spec),
            None => self.engine.processes.spawn(spec),
        };
        match result {
            Ok(id) => self.runs.push(Run { id, owner, command: line, started: Instant::now(), ended: None, lines: VecDeque::new(), dropped: 0 }),
            Err(e) => self.say(e.to_string(), true),
        }
        if self.runs.len() > 200 {
            self.runs.remove(0);
        }
    }
}

// ── small drawing helpers ──────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Icon {
    Home,
    Terminal,
    Gear,
    Minimize,
    Maximize,
    Restore,
    Close,
}

fn draw_icon(dl: &dear_imgui_rs::DrawListMut<'_>, icon: Icon, c: [f32; 2], s: f32, color: theme::Rgba) {
    let h = s / 2.0;
    let t = 1.4;
    let line = |a: [f32; 2], b: [f32; 2]| dl.add_line(a, b, color).thickness(t).build();
    match icon {
        Icon::Home => {
            line([c[0] - h, c[1] - 1.0], [c[0], c[1] - h]);
            line([c[0], c[1] - h], [c[0] + h, c[1] - 1.0]);
            dl.add_rect([c[0] - h * 0.7, c[1] - 2.0], [c[0] + h * 0.7, c[1] + h], color).thickness(t).build();
        }
        Icon::Terminal => {
            line([c[0] - h, c[1] - h * 0.6], [c[0] - h * 0.3, c[1]]);
            line([c[0] - h * 0.3, c[1]], [c[0] - h, c[1] + h * 0.6]);
            line([c[0] + 0.0, c[1] + h * 0.7], [c[0] + h, c[1] + h * 0.7]);
        }
        Icon::Gear => {
            dl.add_circle(c, h * 0.45, color).thickness(t).build();
            for k in 0..8 {
                let a = k as f32 * std::f32::consts::FRAC_PI_4;
                let (sa, ca) = a.sin_cos();
                line([c[0] + ca * h * 0.7, c[1] + sa * h * 0.7], [c[0] + ca * h, c[1] + sa * h]);
            }
        }
        Icon::Minimize => line([c[0] - h, c[1]], [c[0] + h, c[1]]),
        Icon::Maximize => {
            dl.add_rect([c[0] - h, c[1] - h], [c[0] + h, c[1] + h], color).thickness(1.0).build();
        }
        Icon::Restore => {
            dl.add_rect([c[0] - h, c[1] - h + 2.0], [c[0] + h - 2.0, c[1] + h], color).thickness(1.0).build();
            line([c[0] - h + 2.0, c[1] - h], [c[0] + h, c[1] - h]);
            line([c[0] + h, c[1] - h], [c[0] + h, c[1] + h - 2.0]);
        }
        Icon::Close => {
            line([c[0] - h, c[1] - h], [c[0] + h, c[1] + h]);
            line([c[0] + h, c[1] - h], [c[0] - h, c[1] + h]);
        }
    }
}

fn chevron(dl: &dear_imgui_rs::DrawListMut<'_>, c: [f32; 2], color: theme::Rgba) {
    dl.add_line([c[0] - 3.5, c[1] - 1.5], [c[0], c[1] + 2.0], color).thickness(1.3).build();
    dl.add_line([c[0], c[1] + 2.0], [c[0] + 3.5, c[1] - 1.5], color).thickness(1.3).build();
}

/// Text with extra space between letters (the OXIS wordmark, labels).
/// Each glyph is measured in its own font, so proportional fonts space
/// evenly too.
#[allow(clippy::too_many_arguments)]
fn spaced_text(
    ui: &Ui,
    dl: &dear_imgui_rs::DrawListMut<'_>,
    font: dear_imgui_rs::FontId,
    size: f32,
    pos: [f32; 2],
    color: theme::Rgba,
    text: &str,
    spacing: f32,
) -> f32 {
    let _f = ui.push_font_with_size(Some(font), size);
    let mut x = pos[0];
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        let s = ch.encode_utf8(&mut buf);
        dl.add_text_with_font(font, size, [x, pos[1]], color, &*s, 0.0, None);
        x += ui.calc_text_size(&*s)[0] + spacing;
    }
    x - pos[0]
}

/// A small upper-case label with a status dot.
fn eyebrow(ui: &Ui, fonts: Fonts, p: &Palette, text: &str, on: bool) {
    let dl = ui.get_window_draw_list();
    let pos = ui.cursor_screen_pos();
    dl.add_circle([pos[0] + 4.0, pos[1] + 8.0], 3.5, col(if on { p.acc } else { p.dim })).filled(true).build();
    spaced_text(ui, &dl, fonts.ui_semibold, size::XS - 0.5, [pos[0] + 14.0, pos[1] + 2.0], col(p.muted), text, 1.6);
    ui.dummy([0.0, 18.0]);
}

/// A hairline panel with a labelled header; `body` draws inside it.
fn panel(ui: &Ui, fonts: Fonts, p: &Palette, title: &str, width: f32, height: f32, body: impl FnOnce()) {
    let _bg = ui.push_style_color(StyleColor::ChildBg, p.panel());
    let _bd = ui.push_style_color(StyleColor::Border, p.line2());
    let _pad = ui.push_style_var(dear_imgui_rs::StyleVar::WindowPadding([16.0, 12.0]));
    ui.child_window(title).size([width, height]).child_flags(dear_imgui_rs::ChildFlags::BORDERS | dear_imgui_rs::ChildFlags::ALWAYS_USE_WINDOW_PADDING).build(
        ui,
        || {
            let dl = ui.get_window_draw_list();
            let pos = ui.cursor_screen_pos();
            dl.add_rect([pos[0], pos[1] + 4.0], [pos[0] + 6.0, pos[1] + 10.0], col(p.acc)).filled(true).rounding(1.0).build();
            spaced_text(ui, &dl, fonts.ui_semibold, size::XS - 0.5, [pos[0] + 14.0, pos[1]], col(p.muted), &title.to_uppercase(), 1.6);
            ui.dummy([0.0, 16.0]);
            ui.separator();
            ui.dummy([0.0, 6.0]);
            body();
        },
    );
}

/// A button in the OXIS style; `primary` is the green one.
fn button(ui: &Ui, label: &str, primary: bool) -> bool {
    let p = Palette::default();
    if !primary {
        return ui.button(label);
    }
    // Separate bindings: ImGui's style stack must be popped in reverse.
    let _c1 = ui.push_style_color(StyleColor::Button, p.acc);
    let _c2 = ui.push_style_color(StyleColor::ButtonHovered, p.acc_hi);
    let _c3 = ui.push_style_color(StyleColor::ButtonActive, p.acc_lo);
    let _c4 = ui.push_style_color(StyleColor::Text, p.bg1);
    ui.button(label)
}

fn setting_row(ui: &Ui, fonts: Fonts, p: &Palette, label: &str, description: &str, control: impl FnOnce()) {
    let width = ui.content_region_avail()[0].min(860.0);
    let start = ui.cursor_screen_pos();
    {
        let _f = ui.push_font_with_size(Some(fonts.ui_medium), size::MD);
        ui.text(label);
    }
    {
        let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
        let _c = ui.push_style_color(StyleColor::Text, p.muted);
        ui.text_wrapped(description);
    }
    let after = ui.cursor_screen_pos();
    ui.set_cursor_screen_pos([start[0] + width - 200.0, start[1]]);
    control();
    ui.set_cursor_screen_pos([after[0], after[1].max(ui.cursor_screen_pos()[1]) + 10.0]);
    let dl = ui.get_window_draw_list();
    let y = ui.cursor_screen_pos()[1] - 5.0;
    dl.add_line([start[0], y], [start[0] + width, y], col(p.line())).build();
    // An item after moving the cursor, so the window grows to include it.
    ui.dummy([0.0, 0.0]);
}

/// `~/code` → `/home/me/code`; anything else as typed.
fn expand_home(path: &str) -> PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    match (path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")), home) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ if path == "~" => std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| path.into()),
        _ => PathBuf::from(path),
    }
}

/// Shortens text to fit `width` (in the current font) by cutting out its
/// middle: `C:\\Users\\me\\…\\project`. Paths keep both ends that way.
fn elide_middle(ui: &Ui, text: &str, width: f32) -> String {
    if ui.calc_text_size(text)[0] <= width {
        return text.to_owned();
    }
    let chars: Vec<char> = text.chars().collect();
    let (mut lo, mut hi) = (0usize, chars.len());
    // The most characters that fit, half from each end.
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        let keep = |n: usize| -> String {
            let head = n.div_ceil(2);
            let tail = n / 2;
            chars[..head].iter().chain(std::iter::once(&'…')).chain(chars[chars.len() - tail..].iter()).collect()
        };
        if ui.calc_text_size(keep(mid))[0] <= width {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let head = lo.div_ceil(2);
    let tail = lo / 2;
    chars[..head].iter().chain(std::iter::once(&'…')).chain(chars[chars.len() - tail..].iter()).collect()
}
