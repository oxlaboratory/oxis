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
use dear_imgui_rs::{Condition, Context, Ui, WindowFlags};
use oxide::events::{Event, Stream};
use oxide::ids::{ProcessId, WorkspaceId};
use oxide::process::Status;
use oxide::Engine;
use winit::event_loop::EventLoopProxy;
use winit::window::Window;

use crate::theme::{self, size, Fonts, Palette};

mod chrome;
mod home;
mod run;
mod settings;
mod terminal_view;
use crate::window_state::{self, WindowState};
use crate::Wake;
pub use terminal_view::TermInput;

const TITLE_H: f32 = 38.0;
const RAIL_W: f32 = 48.0;
const STATUS_H: f32 = 24.0;
const PROMPT_H: f32 = 48.0;
const EDGE: f32 = 5.0;
/// Lines kept per command; older ones are dropped (and counted).
const RUN_LINES: usize = 5000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Home,
    Run,
    Terminal,
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
    installed_shells: Vec<String>,
    /// The chosen shell's name, looked up when the setting changes rather
    /// than on every frame.
    shell_name: String,
    term: terminal_view::TermState,
    /// The OXIS logo, uploaded once (see [`Shell::set_logo`]).
    logo: Option<dear_imgui_rs::TextureId>,
    /// Run blocks whose output is folded away.
    collapsed: std::collections::HashSet<ProcessId>,
    /// The new name while a workspace is being renamed on Home.
    renaming: Option<String>,
    focus_rename: bool,
    /// A first click on "Remove": a second one within a few seconds removes.
    confirm_remove: Option<(WorkspaceId, Instant)>,
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
            // Looked up once: probing PATH every frame would be wasteful.
            installed_shells: oxide::terminal::shells::available().into_iter().map(|s| s.name).collect(),
            shell_name: String::new(),
            term: Default::default(),
            logo: None,
            collapsed: Default::default(),
            renaming: None,
            focus_rename: false,
            confirm_remove: None,
        };
        shell.refresh_shell_label();
        shell.restore_workspace();
        shell
    }

    /// Opens a view by name (`home`, `run`, `settings`), for `--view=`.
    pub fn set_view(&mut self, name: &str) {
        self.view = match name {
            "run" => View::Run,
            "terminal" => View::Terminal,
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
            "view": match self.view { View::Home => "home", View::Run => "run", View::Terminal => "terminal", View::Settings => "settings" },
            "terminal": self.terminal_dump(),
            "search": self.search_dump(),
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
                Event::SessionExited { id, code } => self.term.session_exited(id, code),
                Event::SessionClosed { id } => self.term.session_closed(id),
                // A program copying (OSC 52); reading the clipboard is refused.
                Event::SessionClipboard { text, .. } => self.term.copy(&text),
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
        self.engine.terminals.close_all();
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
                self.nav_shortcuts(ui);
                self.title_bar(ui, window, fonts, display, &mut actions);
                self.rail(ui, fonts, display);
                let content = [RAIL_W, TITLE_H, display[0], display[1] - STATUS_H];
                match self.view {
                    View::Home => self.home(ui, fonts, content),
                    View::Run => self.run_view(ui, fonts, content),
                    View::Terminal => self.terminal_view(ui, fonts, content),
                    View::Settings => self.settings(ui, fonts, content),
                }
                self.status_bar(ui, fonts, display);
                self.notice_toast(ui, fonts, display, &mut actions);
                self.resize_edges(ui, window, display);
            });
        actions
    }

    // ── running commands ───────────────────────────────────────────────

    fn shell_label(&self) -> String {
        self.shell_name.clone()
    }

    fn refresh_shell_label(&mut self) {
        self.shell_name = match self.engine.shell() {
            Ok(sh) => sh.name,
            Err(_) => format!("{} (not installed)", self.engine.settings.shell),
        };
    }

    /// Hands the shell the uploaded logo texture for the title bar.
    pub fn set_logo(&mut self, tex: dear_imgui_rs::TextureId) {
        self.logo = Some(tex);
    }

    /// Ctrl+1/2/3 and Ctrl+, open the views, unless a text field has the
    /// keyboard. (A focused terminal gets them through `terminal_input`.)
    fn nav_shortcuts(&mut self, ui: &Ui) {
        if ui.io().want_text_input() || !ui.io().key_ctrl() {
            return;
        }
        use dear_imgui_rs::Key;
        for (key, view) in [(Key::Key1, View::Home), (Key::Key2, View::Run), (Key::Key3, View::Terminal), (Key::Comma, View::Settings)] {
            if ui.is_key_pressed(key) {
                self.go(view);
            }
        }
    }

    /// The view a navigation shortcut opens, for keys that reached a
    /// terminal first.
    fn nav_view(input: &TermInput) -> Option<View> {
        match input {
            TermInput::Char(c, m) if m.ctrl && !m.alt && !m.shift => match c {
                '1' => Some(View::Home),
                '2' => Some(View::Run),
                '3' => Some(View::Terminal),
                ',' => Some(View::Settings),
                _ => None,
            },
            _ => None,
        }
    }

    fn start_run(&mut self, line: String) {
        let owner = self.active_id();
        match self.engine.run_command(owner, &line) {
            Ok(id) => self.runs.push(Run { id, owner, command: line, started: Instant::now(), ended: None, lines: VecDeque::new(), dropped: 0 }),
            Err(e) => self.say(e.to_string(), true),
        }
        if self.runs.len() > 200 {
            self.runs.remove(0);
        }
    }
}

// ── small drawing helpers ──────────────────────────────────────────────

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
