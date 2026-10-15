//! The Terminal view: tabs of real shells, each tab split into panes.
//!
//! The engine owns the sessions (`oxide::terminal`); this file owns only
//! how they're laid out on screen — which tab holds which panes — per
//! workspace, so switching workspaces swaps the whole layout and the
//! sessions keep running behind it. Keys go straight to the focused shell
//! (see [`Shell::terminal_input`]); nothing is typed into an ImGui widget.

use std::collections::HashMap;

use dear_imgui_rs::{MouseButton, MouseCursor, Ui};
use oxide::ids::{SessionId, WorkspaceId};
use oxide::terminal::keys::{self, Key, Mods};
use oxide::terminal::{CellFlags, CursorShape, Screen};

use crate::theme::space;

use super::Shell;
use crate::icons::{self, Icon};
use crate::theme::{self, col, size, Fonts};
use crate::widgets;

const TABS_H: f32 = 34.0;
const PAD: f32 = 8.0;
const SPLITTER: f32 = 6.0;

/// One key press for a terminal, from the window or a drive script.
#[derive(Clone, Debug, PartialEq)]
pub enum TermInput {
    /// Text typed (no Ctrl or Alt held).
    Text(String),
    /// A character with Ctrl and/or Alt (Ctrl+C, Alt+F, …).
    Char(char, Mods),
    Key(Key, Mods),
}

#[derive(Clone, Debug)]
enum Pane {
    Leaf(SessionId),
    /// `across`: side by side (a vertical divider); otherwise stacked.
    Split {
        across: bool,
        ratio: f32,
        a: Box<Pane>,
        b: Box<Pane>,
    },
}

impl Pane {
    fn leaves(&self, out: &mut Vec<SessionId>) {
        match self {
            Pane::Leaf(id) => out.push(*id),
            Pane::Split { a, b, .. } => {
                a.leaves(out);
                b.leaves(out);
            }
        }
    }

    /// Splits the pane showing `target`, putting `new` beside or below it.
    fn split(&mut self, target: SessionId, new: SessionId, across: bool) -> bool {
        match self {
            Pane::Leaf(id) if *id == target => {
                *self = Pane::Split { across, ratio: 0.5, a: Box::new(Pane::Leaf(target)), b: Box::new(Pane::Leaf(new)) };
                true
            }
            Pane::Leaf(_) => false,
            Pane::Split { a, b, .. } => a.split(target, new, across) || b.split(target, new, across),
        }
    }

    /// The tree without `target`'s pane (its sibling takes its place), or
    /// `None` if nothing is left.
    fn without(self, target: SessionId) -> Option<Pane> {
        match self {
            Pane::Leaf(id) if id == target => None,
            leaf @ Pane::Leaf(_) => Some(leaf),
            Pane::Split { across, ratio, a, b } => match (a.without(target), b.without(target)) {
                (Some(a), Some(b)) => Some(Pane::Split { across, ratio, a: Box::new(a), b: Box::new(b) }),
                (Some(only), None) | (None, Some(only)) => Some(only),
                (None, None) => None,
            },
        }
    }

    fn node_mut(&mut self, path: &[bool]) -> Option<&mut Pane> {
        match (path.split_first(), self) {
            (None, node) => Some(node),
            (Some((side, rest)), Pane::Split { a, b, .. }) => if *side { b } else { a }.node_mut(rest),
            _ => None,
        }
    }
}

struct Tab {
    root: Pane,
    focus: SessionId,
}

impl Tab {
    fn leaves(&self) -> Vec<SessionId> {
        let mut v = Vec::new();
        self.root.leaves(&mut v);
        v
    }
}

#[derive(Default)]
struct Layout {
    tabs: Vec<Tab>,
    active: usize,
    /// Why the last attempt to open a terminal failed (shown instead of
    /// retrying every frame).
    failed: Option<String>,
    /// A first terminal opens by itself; after the last one is closed the
    /// view waits to be asked.
    opened: bool,
}

/// The Terminal view's own state.
#[derive(Default)]
pub struct TermState {
    layouts: HashMap<Option<WorkspaceId>, Layout>,
    screens: HashMap<SessionId, Screen>,
    exited: HashMap<SessionId, Option<i32>>,
    /// A selection being dragged: the session and the cell it started at.
    selecting: Option<(SessionId, (usize, usize), bool)>,
    /// The divider being dragged (its path in the pane tree).
    dragging: Option<Vec<bool>>,
    /// Set while drawing: whether keys should go to the focused shell.
    has_keys: bool,
    clipboard: Option<arboard::Clipboard>,
    /// Search in a terminal's scrollback (Ctrl+Shift+F).
    search: Option<Search>,
    /// A mouse button held down in a program that takes the mouse: where
    /// it was last reported.
    mouse_down: Option<(SessionId, oxide::terminal::keys::MouseButton, (usize, usize))>,
    /// The cell the mouse was last reported over (for motion reporting).
    mouse_at: Option<(usize, usize)>,
    /// Where each pane was drawn this frame.
    pane_rects: HashMap<SessionId, [f32; 4]>,
}

struct Search {
    session: SessionId,
    query: String,
    /// The query the matches are for.
    searched: String,
    matches: Vec<oxide::terminal::Match>,
    /// Which match is current (an index into `matches`).
    current: usize,
    focus: bool,
}

impl TermState {
    pub fn session_exited(&mut self, id: SessionId, code: Option<i32>) {
        self.exited.insert(id, code);
    }

    pub fn session_closed(&mut self, id: SessionId) {
        self.screens.remove(&id);
        self.exited.remove(&id);
    }

    pub fn copy(&mut self, text: &str) {
        if self.clipboard.is_none() {
            self.clipboard = arboard::Clipboard::new().map_err(|e| tracing::warn!("no clipboard: {e}")).ok();
        }
        if let Some(c) = self.clipboard.as_mut() {
            if let Err(e) = c.set_text(text.to_owned()) {
                tracing::warn!("couldn't copy: {e}");
            }
        }
    }

    fn paste_text(&mut self) -> Option<String> {
        if self.clipboard.is_none() {
            self.clipboard = arboard::Clipboard::new().ok();
        }
        self.clipboard.as_mut()?.get_text().ok()
    }
}

impl Shell {
    fn layout_key(&self) -> Option<WorkspaceId> {
        self.active_id()
    }

    fn layout(&mut self) -> &mut Layout {
        let key = self.layout_key();
        self.term.layouts.entry(key).or_default()
    }

    fn focused_session(&self) -> Option<SessionId> {
        let l = self.term.layouts.get(&self.layout_key())?;
        l.tabs.get(l.active).map(|t| t.focus)
    }

    /// Whether key presses should go to the focused terminal right now.
    pub fn terminal_has_keys(&self) -> bool {
        self.term.has_keys
    }

    /// Opens a terminal tab from elsewhere (Home's "Open terminal").
    pub(super) fn open_terminal_tab(&mut self) {
        self.layout().opened = true;
        self.new_tab();
    }

    /// Opens a new tab with a fresh shell, sized for now; it's resized to
    /// its pane on the next frame.
    fn new_tab(&mut self) {
        let ws = self.active_id();
        match self.engine.open_terminal(ws, 80, 24) {
            Ok(id) => {
                let l = self.layout();
                l.tabs.push(Tab { root: Pane::Leaf(id), focus: id });
                l.active = l.tabs.len() - 1;
                l.failed = None;
            }
            Err(e) => {
                let msg = e.to_string();
                self.layout().failed = Some(msg.clone());
                self.say(msg, true);
            }
        }
    }

    fn split_focused(&mut self, across: bool) {
        let Some(focus) = self.focused_session() else {
            return self.new_tab();
        };
        match self.engine.open_terminal(self.active_id(), 80, 24) {
            Ok(new) => {
                let l = self.layout();
                let tab = &mut l.tabs[l.active];
                if tab.root.split(focus, new, across) {
                    tab.focus = new;
                }
            }
            Err(e) => self.say(e.to_string(), true),
        }
    }

    /// Closes a pane and its session; an empty tab goes too.
    fn close_pane(&mut self, id: SessionId) {
        let _ = self.engine.terminals.close(id);
        self.term.session_closed(id);
        let l = self.layout();
        if let Some(t) = l.tabs.iter().position(|t| t.leaves().contains(&id)) {
            let tab = l.tabs.remove(t);
            if let Some(root) = tab.root.without(id) {
                let mut left = Vec::new();
                root.leaves(&mut left);
                let focus = if tab.focus == id { left[0] } else { tab.focus };
                l.tabs.insert(t, Tab { root, focus });
            }
            l.active = l.active.min(l.tabs.len().saturating_sub(1));
        }
    }

    fn close_tab(&mut self, index: usize) {
        let ids = self.layout().tabs.get(index).map(|t| t.leaves()).unwrap_or_default();
        for id in ids {
            self.close_pane(id);
        }
    }

    /// A key press for the focused terminal: OXIS's own shortcuts first,
    /// then the bytes the shell expects. Returns whether it was used.
    pub fn terminal_input(&mut self, input: TermInput) -> bool {
        if !self.term.has_keys {
            return false;
        }
        if let Some(view) = Self::nav_view(&input) {
            self.go(view);
            return true;
        }
        let Some(id) = self.focused_session() else { return false };
        let Some(session) = self.engine.terminals.get(id) else { return false };
        let t = session.terminal;
        let cs = |m: Mods| m.ctrl && m.shift && !m.alt;
        match &input {
            TermInput::Char(c, m) if cs(*m) => match c.to_ascii_lowercase() {
                't' => self.new_tab(),
                'f' => {
                    self.term.search =
                        Some(Search { session: id, query: String::new(), searched: String::new(), matches: Vec::new(), current: 0, focus: true });
                }
                'w' => self.close_pane(id),
                'd' => self.split_focused(true),
                'e' => self.split_focused(false),
                'c' => {
                    if let Some(text) = t.selection_text() {
                        self.term.copy(&text);
                    }
                }
                'v' => {
                    if let Some(text) = self.term.paste_text() {
                        t.paste(&text);
                    }
                }
                _ => return false,
            },
            TermInput::Key(Key::Tab, m) if m.ctrl => {
                let back = m.shift;
                let l = self.layout();
                if !l.tabs.is_empty() {
                    let n = l.tabs.len();
                    l.active = if back { (l.active + n - 1) % n } else { (l.active + 1) % n };
                }
            }
            TermInput::Key(k @ (Key::PageUp | Key::PageDown), m) if m.shift && !t.alt_screen() => {
                let rows = t.size().1 as i32;
                t.scroll(if *k == Key::PageUp { rows - 1 } else { 1 - rows });
            }
            _ if self.term.exited.contains_key(&id) => {
                // A finished shell: Enter closes its pane, the rest is ignored.
                if matches!(input, TermInput::Key(Key::Enter, _)) {
                    self.close_pane(id);
                }
            }
            // Ctrl+C with something selected copies it, as in other terminals.
            TermInput::Char('c', m) if m.ctrl && !m.alt && t.selection_text().is_some() => {
                if let Some(text) = t.selection_text() {
                    self.term.copy(&text);
                }
                t.clear_selection();
            }
            TermInput::Char('v', m) if cfg!(windows) && m.ctrl && !m.alt => {
                if let Some(text) = self.term.paste_text() {
                    t.paste(&text);
                }
            }
            TermInput::Text(text) => {
                t.clear_selection();
                t.write(text.as_bytes());
            }
            TermInput::Char(c, m) => {
                t.clear_selection();
                t.write(&keys::encode_char(*c, *m));
            }
            TermInput::Key(k, m) => t.write(&keys::encode(*k, *m, t.app_cursor())),
        }
        true
    }

    /// Whether the focused terminal shows a line containing `text`.
    pub fn terminal_screen_has(&self, text: &str) -> bool {
        let Some(id) = self.focused_session() else { return false };
        let Some(s) = self.engine.terminals.get(id) else { return false };
        let screen = s.terminal.screen();
        (0..screen.rows).any(|r| screen.line(r).contains(text))
    }

    /// The active workspace's terminals, for `--drive` dumps.
    pub fn terminal_dump(&self) -> serde_json::Value {
        let Some(l) = self.term.layouts.get(&self.layout_key()) else {
            return serde_json::json!({ "tabs": [] });
        };
        let tabs: Vec<_> = l
            .tabs
            .iter()
            .map(|tab| {
                let panes: Vec<_> = tab
                    .leaves()
                    .into_iter()
                    .filter_map(|id| self.engine.terminals.get(id).map(|s| (id, s)))
                    .map(|(id, s)| {
                        let t = &s.terminal;
                        let (cols, rows) = t.size();
                        serde_json::json!({
                            "session": id.raw(), "focused": tab.focus == id, "label": s.label, "title": t.title(),
                            "cols": cols, "rows": rows, "exited": self.term.exited.get(&id).map(|c| serde_json::json!({ "code": c })),
                            "text": t.screen().text(), "selection": t.selection_text(),
                        })
                    })
                    .collect();
                serde_json::json!({ "panes": panes })
            })
            .collect();
        serde_json::json!({ "tabs": tabs, "active": l.active, "failed": l.failed, "sessions_running": self.engine.terminals.all().len() })
    }

    pub(super) fn terminal_view(&mut self, ui: &Ui, fonts: Fonts, area: [f32; 4]) {
        let p = self.pal;
        let dl = ui.get_window_draw_list();
        self.term.has_keys = false;

        // Open a first terminal when there's none (once, not every frame
        // after a failure).
        if !self.layout().opened && self.layout().failed.is_none() {
            self.layout().opened = true;
            self.new_tab();
        }

        // The tab strip.
        dl.add_rect([area[0], area[1]], [area[2], area[1] + TABS_H], col(p.chrome2())).filled(true).build();
        dl.add_line([area[0], area[1] + TABS_H - 0.5], [area[2], area[1] + TABS_H - 0.5], col(p.line())).build();
        let mut x = area[0] + 8.0;
        let (mut pick, mut close) = (None, None);
        let tab_labels: Vec<(String, bool)> = {
            let l = self.term.layouts.get(&self.layout_key());
            l.map(|l| {
                l.tabs
                    .iter()
                    .enumerate()
                    .map(|(i, t)| {
                        let label = self
                            .engine
                            .terminals
                            .get(t.focus)
                            .map(|s| {
                                let title = s.terminal.title();
                                tab_label(&title, &s.label)
                            })
                            .unwrap_or_default();
                        (label, i == l.active)
                    })
                    .collect()
            })
            .unwrap_or_default()
        };
        let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
        for (i, (label, on)) in tab_labels.iter().enumerate() {
            let label = super::elide_middle(ui, label, 180.0);
            let w = ui.calc_text_size(&label)[0] + 44.0;
            let r = [x, area[1] + 5.0, x + w, area[1] + TABS_H];
            ui.set_cursor_screen_pos([r[0], r[1]]);
            if ui.invisible_button(format!("##ttab{i}"), [w - 24.0, r[3] - r[1]]) {
                pick = Some(i);
            }
            self.mark(ui, format!("term-tab:{i}"));
            let hov = ui.is_item_hovered();
            if *on || hov {
                dl.add_rect([r[0], r[1]], [r[2], r[3]], col(if *on { p.bg } else { p.hover() })).filled(true).rounding(5.0).build();
            }
            if *on {
                dl.add_rect([r[0] + 8.0, r[3] - 2.0], [r[2] - 8.0, r[3]], col(p.acc)).filled(true).build();
            }
            dl.add_text([r[0] + 12.0, r[1] + 7.0], col(if *on { p.text } else { p.muted }), &label);
            ui.set_cursor_screen_pos([r[2] - 24.0, r[1] + 5.0]);
            if ui.invisible_button(format!("##tclose{i}"), [18.0, 18.0]) {
                close = Some(i);
            }
            self.mark(ui, format!("term-tab-close:{i}"));
            let ch = ui.is_item_hovered();
            icons::draw(&dl, Icon::Close, [r[2] - 15.0, r[1] + 14.0], 7.0, col(if ch { p.text } else { p.dim }));
            x = r[2] + 4.0;
        }
        // New tab, and the splits at the right.
        // The buttons draw themselves: only one draw list handle may be alive.
        drop(dl);
        // New tab after the tabs; the splits at the right.
        let buttons = [
            ("term-new", Icon::Plus, "New terminal", "Ctrl+Shift+T"),
            ("term-split-right", Icon::SplitRight, "Split right", "Ctrl+Shift+D"),
            ("term-split-down", Icon::SplitDown, "Split down", "Ctrl+Shift+E"),
        ];
        let mut actions = [false; 3];
        for (k, (name, icon, tip, keys)) in buttons.iter().enumerate() {
            let bx = if k == 0 { x + 2.0 } else { area[2] - 6.0 - (3 - k) as f32 * 30.0 };
            ui.set_cursor_screen_pos([bx, area[1] + (TABS_H - 28.0) / 2.0]);
            actions[k] = widgets::icon_button(ui, fonts, &format!("##{name}"), *icon, tip, Some(keys));
            self.mark(ui, *name);
        }
        drop(_f);
        if let Some(i) = pick {
            self.layout().active = i;
        }
        if let Some(i) = close {
            self.close_tab(i);
        }
        if actions[0] {
            self.new_tab();
        }
        if actions[1] {
            self.split_focused(true);
        }
        if actions[2] {
            self.split_focused(false);
        }

        let body = [area[0], area[1] + TABS_H, area[2], area[3]];
        let dl = ui.get_window_draw_list();
        dl.add_rect([body[0], body[1]], [body[2], body[3]], col(p.bg)).filled(true).build();
        // Panes take their own draw list handle; only one may be alive.
        drop(dl);
        let layout_tab = {
            let l = self.layout();
            l.tabs.get(l.active).map(|t| (t.root.clone(), t.focus))
        };
        let Some((root, focus)) = layout_tab else {
            let failed = self.layout().failed.clone();
            ui.set_cursor_screen_pos([body[0] + 28.0, body[1] + 24.0]);
            ui.text_disabled(failed.as_deref().unwrap_or("No terminals open."));
            ui.set_cursor_screen_pos([body[0] + 28.0, body[1] + 52.0]);
            if widgets::button(ui, fonts, "##term-open", "Open a terminal", Some(Icon::Terminal), widgets::Kind::Primary) {
                self.layout().failed = None;
                self.new_tab();
            }
            self.mark(ui, "term-open");
            return;
        };
        let mut leaf_index = 0;
        self.term.pane_rects.clear();
        self.draw_pane_tree(ui, fonts, &root, body, focus, &mut Vec::new(), &mut leaf_index);
        self.search_bar(ui, fonts);
        // Keys go to the shell unless an ImGui text field has them.
        self.term.has_keys = self.view == super::View::Terminal && !ui.io().want_text_input();
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_pane_tree(&mut self, ui: &Ui, fonts: Fonts, pane: &Pane, r: [f32; 4], focus: SessionId, path: &mut Vec<bool>, leaf: &mut usize) {
        match pane {
            Pane::Leaf(id) => {
                self.draw_pane(ui, fonts, *id, r, *id == focus, *leaf);
                *leaf += 1;
            }
            Pane::Split { across, ratio, a, b } => {
                let (ra, rb, div) = if *across {
                    let x = r[0] + (r[2] - r[0]) * ratio;
                    ([r[0], r[1], x - SPLITTER / 2.0, r[3]], [x + SPLITTER / 2.0, r[1], r[2], r[3]], [x - SPLITTER / 2.0, r[1], x + SPLITTER / 2.0, r[3]])
                } else {
                    let y = r[1] + (r[3] - r[1]) * ratio;
                    ([r[0], r[1], r[2], y - SPLITTER / 2.0], [r[0], y + SPLITTER / 2.0, r[2], r[3]], [r[0], y - SPLITTER / 2.0, r[2], y + SPLITTER / 2.0])
                };
                path.push(false);
                self.draw_pane_tree(ui, fonts, a, ra, focus, path, leaf);
                path.pop();
                path.push(true);
                self.draw_pane_tree(ui, fonts, b, rb, focus, path, leaf);
                path.pop();

                // The divider: drag to resize.
                let p = self.pal;
                let dl = ui.get_window_draw_list();
                ui.set_cursor_screen_pos([div[0], div[1]]);
                let key = format!("##split{}", path.iter().map(|b| if *b { '1' } else { '0' }).collect::<String>());
                ui.invisible_button(key, [div[2] - div[0], div[3] - div[1]]);
                let hov = ui.is_item_hovered();
                if ui.is_item_active() {
                    self.term.dragging = Some(path.clone());
                }
                if hov || self.term.dragging.as_deref() == Some(path.as_slice()) {
                    ui.set_mouse_cursor(Some(if *across { MouseCursor::ResizeEW } else { MouseCursor::ResizeNS }));
                }
                let line_c = col(if hov { p.acc } else { p.line2() });
                if *across {
                    let x = (div[0] + div[2]) / 2.0;
                    dl.add_line([x, div[1]], [x, div[3]], line_c).build();
                } else {
                    let y = (div[1] + div[3]) / 2.0;
                    dl.add_line([div[0], y], [div[2], y], line_c).build();
                }
                if self.term.dragging.as_deref() == Some(path.as_slice()) {
                    if ui.is_mouse_down(MouseButton::Left) {
                        let m = ui.io().mouse_pos();
                        let t = if *across { (m[0] - r[0]) / (r[2] - r[0]) } else { (m[1] - r[1]) / (r[3] - r[1]) };
                        let t = t.clamp(0.1, 0.9);
                        let path = path.clone();
                        let l = self.layout();
                        if let Some(Pane::Split { ratio, .. }) = l.tabs.get_mut(l.active).and_then(|tab| tab.root.node_mut(&path)) {
                            *ratio = t;
                        }
                    } else {
                        self.term.dragging = None;
                    }
                }
            }
        }
    }

    fn draw_pane(&mut self, ui: &Ui, fonts: Fonts, id: SessionId, r: [f32; 4], focused: bool, index: usize) {
        let p = self.pal;
        let dl = ui.get_window_draw_list();
        let Some(session) = self.engine.terminals.get(id) else { return };
        let t = session.terminal;
        let fs = self.engine.settings.font_size.clamp(8.0, 32.0);
        let (cw, lh) = {
            let _f = ui.push_font_with_size(Some(fonts.mono), fs);
            // Measured over many characters: one glyph's width comes back
            // rounded, and that error would add up across a line.
            (ui.calc_text_size("M".repeat(100))[0] / 100.0, (fs * 1.32).round())
        };
        self.term.pane_rects.insert(id, r);
        let inner = [r[0] + PAD, r[1] + PAD, r[2] - PAD, r[3] - PAD];
        let cols = (((inner[2] - inner[0]) / cw).floor() as i32).clamp(2, 1000) as u16;
        let rows = (((inner[3] - inner[1]) / lh).floor() as i32).clamp(1, 500) as u16;
        t.resize(cols, rows);

        // Mouse: focus, select, scroll.
        ui.set_cursor_screen_pos([r[0], r[1]]);
        // Controls drawn over the pane later (the search bar) take clicks first.
        ui.set_next_item_allow_overlap();
        ui.invisible_button(format!("##pane{}", id.raw()), [(r[2] - r[0]).max(1.0), (r[3] - r[1]).max(1.0)]);
        self.mark(ui, format!("term-pane:{index}"));
        let hovered = ui.is_item_hovered();
        let m = ui.io().mouse_pos();
        let cell_at = |m: [f32; 2]| -> (usize, usize) {
            let c = ((m[0] - inner[0]) / cw).floor().clamp(0.0, cols as f32 - 1.0) as usize;
            let rr = ((m[1] - inner[1]) / lh).floor().clamp(0.0, rows as f32 - 1.0) as usize;
            (rr, c)
        };
        // A program that asked for the mouse gets it, unless Shift is held
        // (Shift keeps OXIS's own selecting and scrolling, as elsewhere).
        let io_mods = Mods { ctrl: ui.io().key_ctrl(), alt: ui.io().key_alt(), shift: false };
        let program_mouse = t.mouse_mode().filter(|_| !ui.io().key_shift());
        if let Some(mode) = program_mouse {
            use oxide::terminal::keys::{encode_mouse, MouseAction, MouseButton as MB};
            let send = |button: MB, action: MouseAction, at: (usize, usize)| {
                if let Some(bytes) = encode_mouse(mode, button, action, at.0, at.1, io_mods) {
                    t.write(&bytes);
                }
            };
            let at = cell_at(m);
            if hovered {
                for (b, mb) in [(MouseButton::Left, MB::Left), (MouseButton::Middle, MB::Middle), (MouseButton::Right, MB::Right)] {
                    if ui.is_mouse_clicked(b) {
                        if b == MouseButton::Left {
                            let l = self.layout();
                            if let Some(tab) = l.tabs.get_mut(l.active) {
                                tab.focus = id;
                            }
                        }
                        send(mb, MouseAction::Press, at);
                        self.term.mouse_down = Some((id, mb, at));
                    }
                }
                let wheel = ui.io().mouse_wheel();
                if wheel != 0.0 {
                    let n = (wheel.abs() * 3.0).round().max(1.0) as usize;
                    for _ in 0..n {
                        send(if wheel > 0.0 { MB::WheelUp } else { MB::WheelDown }, MouseAction::Press, at);
                    }
                }
            }
            if let Some((sid, mb, last)) = self.term.mouse_down {
                if sid == id {
                    let released = match mb {
                        MB::Left => !ui.is_mouse_down(MouseButton::Left),
                        MB::Middle => !ui.is_mouse_down(MouseButton::Middle),
                        MB::Right => !ui.is_mouse_down(MouseButton::Right),
                        _ => true,
                    };
                    if released {
                        send(mb, MouseAction::Release, at);
                        self.term.mouse_down = None;
                    } else if (mode.drag || mode.motion) && at != last {
                        send(mb, MouseAction::Move, at);
                        self.term.mouse_down = Some((sid, mb, at));
                    }
                }
            } else if hovered && mode.motion && Some(at) != self.term.mouse_at {
                send(MB::None, MouseAction::Move, at);
            }
            self.term.mouse_at = hovered.then_some(at);
            if hovered {
                ui.set_mouse_cursor(Some(MouseCursor::Arrow));
            }
        } else if hovered {
            ui.set_mouse_cursor(Some(MouseCursor::TextInput));
            if ui.is_mouse_clicked(MouseButton::Left) {
                let l = self.layout();
                if let Some(tab) = l.tabs.get_mut(l.active) {
                    tab.focus = id;
                }
                self.term.selecting = Some((id, cell_at(m), false));
            }
            let wheel = ui.io().mouse_wheel();
            if wheel != 0.0 {
                let lines = (wheel * 3.0).round() as i32;
                if t.alt_screen() {
                    // Full-screen programs (less, editors) scroll themselves.
                    let k = if lines > 0 { Key::Up } else { Key::Down };
                    for _ in 0..lines.unsigned_abs() {
                        t.write(&keys::encode(k, Mods::NONE, t.app_cursor()));
                    }
                } else {
                    t.scroll(lines);
                }
            }
        }
        if let Some((sid, start, moved)) = self.term.selecting {
            if sid == id {
                if ui.is_mouse_down(MouseButton::Left) {
                    let now = cell_at(m);
                    if now != start || moved {
                        t.select(start, now);
                        self.term.selecting = Some((sid, start, true));
                    }
                } else {
                    if !moved {
                        t.clear_selection();
                    }
                    self.term.selecting = None;
                }
            }
        }

        // The cells.
        let changed = t.take_dirty();
        if changed || !self.term.screens.contains_key(&id) || self.term.screens[&id].cols != cols as usize || self.term.screens[&id].rows != rows as usize {
            self.term.screens.insert(id, t.screen());
        }
        let screen = &self.term.screens[&id];
        let rgb = |c: [u8; 3]| [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0, 1.0];
        let bg_default = screen.background;
        let sel_bg = [0x2e, 0x4a, 0x3a];
        let _clip = dl.push_clip_rect([r[0], r[1]], [r[2], r[3]], true);
        let mut text_run = String::new();
        for row in 0..screen.rows {
            let y = inner[1] + row as f32 * lh;
            // Backgrounds, in runs.
            let mut c0 = 0;
            while c0 < screen.cols {
                let cell = screen.cell(row, c0);
                let bg = if cell.flags.has(CellFlags::SELECTED) { sel_bg } else { cell.bg };
                let mut c1 = c0 + 1;
                while c1 < screen.cols {
                    let n = screen.cell(row, c1);
                    let nb = if n.flags.has(CellFlags::SELECTED) { sel_bg } else { n.bg };
                    if nb != bg {
                        break;
                    }
                    c1 += 1;
                }
                if bg != bg_default {
                    dl.add_rect([inner[0] + c0 as f32 * cw, y], [inner[0] + c1 as f32 * cw, y + lh], rgb(bg)).filled(true).build();
                }
                c0 = c1;
            }
            // Search matches on this row: the current one in green.
            if let Some(search) = self.term.search.as_ref().filter(|q| q.session == id) {
                let line = row as i32 - screen.scrolled as i32;
                for (i, m) in search.matches.iter().enumerate().filter(|(_, m)| m.line == line) {
                    let x0 = inner[0] + m.col as f32 * cw;
                    let c = if i == search.current { theme::alpha(p.acc, 0.55) } else { theme::alpha(p.warn, 0.32) };
                    dl.add_rect([x0, y], [x0 + m.len as f32 * cw, y + lh], c).filled(true).rounding(2.0).build();
                }
            }
            // Text: runs of plain ASCII in one style; anything else drawn
            // on its own at its cell, so wide and fallback glyphs line up.
            let mut c0 = 0;
            while c0 < screen.cols {
                let cell = *screen.cell(row, c0);
                if cell.flags.has(CellFlags::SPACER) || cell.ch == ' ' && !cell.flags.has(CellFlags::UNDERLINE) {
                    c0 += 1;
                    continue;
                }
                let bold = cell.flags.has(CellFlags::BOLD);
                let font = if bold { fonts.mono_bold } else { fonts.mono };
                let x = inner[0] + c0 as f32 * cw;
                if cell.ch.is_ascii() {
                    text_run.clear();
                    let mut c1 = c0;
                    while c1 < screen.cols {
                        let n = screen.cell(row, c1);
                        if !n.ch.is_ascii()
                            || n.fg != cell.fg
                            || n.flags.has(CellFlags::BOLD) != bold
                            || n.flags.has(CellFlags::UNDERLINE) != cell.flags.has(CellFlags::UNDERLINE)
                        {
                            break;
                        }
                        text_run.push(n.ch);
                        c1 += 1;
                    }
                    let trimmed = text_run.trim_end();
                    dl.add_text_with_font(font, fs, [x, y + (lh - fs) / 2.0 - 1.0], rgb(cell.fg), trimmed, 0.0, None);
                    if cell.flags.has(CellFlags::UNDERLINE) {
                        dl.add_line([x, y + lh - 3.0], [x + (c1 - c0) as f32 * cw, y + lh - 3.0], rgb(cell.fg)).build();
                    }
                    c0 = c1;
                } else {
                    let mut buf = [0u8; 4];
                    dl.add_text_with_font(font, fs, [x, y + (lh - fs) / 2.0 - 1.0], rgb(cell.fg), cell.ch.encode_utf8(&mut buf), 0.0, None);
                    c0 += 1;
                }
            }
        }
        // The cursor: solid where you're typing, an outline elsewhere.
        if let Some((cr, cc, shape)) = screen.cursor {
            let x = inner[0] + cc as f32 * cw;
            let y = inner[1] + cr as f32 * lh;
            let cur = rgb([0x4f, 0xd4, 0x7f]);
            match (focused, shape) {
                (true, CursorShape::Beam) => {
                    dl.add_rect([x, y + 1.0], [x + 2.0, y + lh - 1.0], cur).filled(true).build();
                }
                (true, CursorShape::Underline) => {
                    dl.add_rect([x, y + lh - 3.0], [x + cw, y + lh - 1.0], cur).filled(true).build();
                }
                (true, CursorShape::Block) => {
                    dl.add_rect([x, y + 1.0], [x + cw, y + lh - 1.0], cur).filled(true).build();
                    let cell = screen.cell(cr, cc);
                    if cell.ch != ' ' {
                        let mut buf = [0u8; 4];
                        dl.add_text_with_font(fonts.mono, fs, [x, y + (lh - fs) / 2.0 - 1.0], rgb(bg_default), cell.ch.encode_utf8(&mut buf), 0.0, None);
                    }
                }
                (false, _) => {
                    dl.add_rect([x, y + 1.0], [x + cw, y + lh - 1.0], theme::alpha(cur, 0.7)).thickness(1.0).build();
                }
            }
        }
        // Scrolled back: say so, so it's clear new output is below.
        if screen.scrolled > 0 {
            let label = format!("↑ {} lines back · Shift+PageDown or type to return", screen.scrolled);
            let _f = ui.push_font_with_size(Some(fonts.ui), size::XS);
            let w = ui.calc_text_size(&label)[0] + 20.0;
            dl.add_rect([r[2] - w - 10.0, r[1] + 8.0], [r[2] - 10.0, r[1] + 30.0], col(p.overlay())).filled(true).rounding(5.0).build();
            dl.add_text([r[2] - w, r[1] + 12.0], col(p.muted), &label);
        }
        if let Some(code) = self.term.exited.get(&id) {
            let label = match code {
                // Windows status codes (negative as i32) read better in hex.
                Some(c) if *c < 0 => format!("The shell exited (code 0x{:08X}). Press Enter to close.", *c as u32),
                Some(c) => format!("The shell exited (code {c}). Press Enter to close."),
                None => "The shell exited. Press Enter to close.".to_owned(),
            };
            let _f = ui.push_font_with_size(Some(fonts.ui), size::SM);
            let w = ui.calc_text_size(&label)[0] + 28.0;
            let y = r[3] - 44.0;
            dl.add_rect([r[0] + 12.0, y], [r[0] + 12.0 + w, y + 30.0], col(p.overlay())).filled(true).rounding(6.0).build();
            dl.add_text([r[0] + 26.0, y + 7.0], col(if code == &Some(0) { p.muted } else { p.warn }), &label);
        }
        // The focused pane is outlined when there's more than one.
        let several = {
            let l = self.layout();
            l.tabs.get(l.active).is_some_and(|t| t.leaves().len() > 1)
        };
        if focused && several {
            dl.add_rect([r[0] + 1.0, r[1] + 1.0], [r[2] - 1.0, r[3] - 1.0], col(theme::alpha(p.acc, 0.5))).thickness(1.0).build();
        }
    }
}

/// What a tab is called: the title the program set, except that a bare
/// program path (what Windows consoles set) shows as the program's name.
fn tab_label(title: &str, fallback: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        return fallback.to_owned();
    }
    let looks_like_program = (title.contains('\\') || title.contains('/')) && !title.contains(' ') || title.to_ascii_lowercase().ends_with(".exe");
    if !looks_like_program {
        return title.to_owned();
    }
    // Split by hand: a Windows path must shorten on every system.
    let name = title.rsplit(['\\', '/']).next().unwrap_or(title);
    let stem = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.eq_ignore_ascii_case("exe") => stem,
        _ => name,
    };
    stem.to_owned()
}

impl Shell {
    /// The scrollback search bar, over the top right of the pane it
    /// searches. Typing searches as you go; Enter goes to the next (older)
    /// match, Shift+Enter the previous; Escape closes it.
    fn search_bar(&mut self, ui: &Ui, fonts: Fonts) {
        let Some(search) = self.term.search.as_ref() else { return };
        let id = search.session;
        let (Some(rect), Some(session)) = (self.term.pane_rects.get(&id).copied(), self.engine.terminals.get(id)) else {
            self.term.search = None;
            return;
        };
        let t = session.terminal;
        let p = self.pal;
        let (w, h) = (360.0_f32.min(rect[2] - rect[0] - 16.0), space::CONTROL + 12.0);
        let x = rect[2] - w - 10.0;
        let y = rect[1] + 8.0;
        {
            let dl = ui.get_window_draw_list();
            dl.add_rect([x, y], [x + w, y + h], p.overlay()).filled(true).rounding(6.0).build();
            dl.add_rect([x, y], [x + w, y + h], p.line2()).rounding(6.0).build();
        }
        let mut search = self.term.search.take().expect("checked above");
        ui.set_cursor_screen_pos([x + 6.0, y + 6.0]);
        if std::mem::take(&mut search.focus) {
            ui.set_keyboard_focus_here();
        }
        let input_w = w - 6.0 - 64.0 - 3.0 * space::CONTROL - 6.0;
        let input = widgets::text_input(ui, fonts, "##term-search", &mut search.query, "Find in terminal", input_w, false);
        self.mark(ui, "term-search");
        let typing = ui.is_item_active();
        if search.query != search.searched {
            search.searched = search.query.clone();
            search.matches = t.find(&search.query);
            // Start from the newest match: the one nearest the bottom.
            search.current = search.matches.len().saturating_sub(1);
            if let Some(m) = search.matches.get(search.current) {
                t.reveal(m.line);
            }
        }
        // The count: "3 of 12".
        let count = if search.query.is_empty() {
            String::new()
        } else if search.matches.is_empty() {
            "No results".to_owned()
        } else {
            format!("{} of {}", search.current + 1, search.matches.len())
        };
        ui.same_line_with_spacing(0.0, 0.0);
        let cpos = ui.cursor_screen_pos();
        {
            let dl = ui.get_window_draw_list();
            let c = if !search.query.is_empty() && search.matches.is_empty() { p.err } else { p.muted };
            dl.add_text_with_font(fonts.ui, size::SM, [cpos[0] + 8.0, cpos[1] + space::CONTROL / 2.0 - size::SM * 0.62], c, &count, 0.0, None);
        }
        ui.dummy([64.0, space::CONTROL]);
        ui.same_line_with_spacing(0.0, 0.0);
        let back = widgets::icon_button(ui, fonts, "##term-search-prev", Icon::ChevronUp, "Older match", Some("Enter"));
        self.mark(ui, "term-search-prev");
        ui.same_line_with_spacing(0.0, 0.0);
        let fwd = widgets::icon_button(ui, fonts, "##term-search-next", Icon::ChevronDown, "Newer match", Some("Shift+Enter"));
        self.mark(ui, "term-search-next");
        ui.same_line_with_spacing(0.0, 0.0);
        let close = widgets::icon_button(ui, fonts, "##term-search-close", Icon::Close, "Close", Some("Esc"));
        self.mark(ui, "term-search-close");

        let n = search.matches.len();
        let shift = ui.io().key_shift();
        // Enter in the field (it loses focus on Enter) steps too, and keeps
        // the field focused for the next press.
        let older = back || (input.entered && !shift);
        let newer = fwd || (input.entered && shift);
        if n > 0 && (older || newer) {
            search.current = if older { (search.current + n - 1) % n } else { (search.current + 1) % n };
            t.reveal(search.matches[search.current].line);
        }
        if input.entered {
            search.focus = true;
        }
        let escape = (typing || input.entered) && ui.is_key_pressed(dear_imgui_rs::Key::Escape);
        if close || escape {
            t.scroll_to_bottom();
            return;
        }
        self.term.search = Some(search);
    }

    /// The search state, for `--drive` dumps.
    pub fn search_dump(&self) -> serde_json::Value {
        match &self.term.search {
            Some(s) => serde_json::json!({ "query": s.query, "matches": s.matches.len(), "current": s.current }),
            None => serde_json::Value::Null,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_labels() {
        assert_eq!(tab_label(r"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe", "pwsh"), "powershell");
        assert_eq!(tab_label("/usr/bin/zsh", "zsh"), "zsh");
        assert_eq!(tab_label("", "bash"), "bash");
        assert_eq!(tab_label("vim notes.md", "bash"), "vim notes.md");
        assert_eq!(tab_label("me@host: ~/code", "bash"), "me@host: ~/code");
    }

    #[test]
    fn panes_split_and_close() {
        let (a, b, c) = (SessionId::next(), SessionId::next(), SessionId::next());
        let mut root = Pane::Leaf(a);
        assert!(root.split(a, b, true));
        assert!(root.split(b, c, false));
        let mut v = Vec::new();
        root.leaves(&mut v);
        assert_eq!(v, vec![a, b, c]);
        let root = root.without(b).unwrap();
        let mut v = Vec::new();
        root.leaves(&mut v);
        assert_eq!(v, vec![a, c]);
        let root = root.without(a).unwrap();
        assert!(matches!(root, Pane::Leaf(id) if id == c));
        assert!(root.without(c).is_none());
    }
}
