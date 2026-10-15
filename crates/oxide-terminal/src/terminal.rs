//! One shell in a pseudo-terminal, and the emulator its output goes into.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::event::{Event as TermEvent, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{CursorShape as VteCursor, Processor};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::screen::{Cell, CellFlags, CursorShape, Palette, Screen};

/// What to run in the terminal.
#[derive(Clone, Debug, Default)]
pub struct TerminalCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Added to the inherited environment.
    pub env: Vec<(String, String)>,
}

/// Something the owner of a terminal may want to react to. Sent from the
/// terminal's own threads.
#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    /// New output: the screen changed. Sent once until
    /// [`Terminal::take_dirty`] is next called, however much output arrives
    /// in between.
    Output,
    /// The program set the window title.
    Title(String),
    Bell,
    /// The program asked to put text on the clipboard (OSC 52).
    Clipboard(String),
    /// The shell exited, with its exit code when it has one.
    Exited(Option<i32>),
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("couldn't create a pseudo-terminal: {0}")]
    Pty(String),
    #[error("couldn't start {program}: {message}")]
    Start { program: String, message: String },
    #[error("{0} isn't a folder (it may have been moved or deleted)")]
    NotAFolder(PathBuf),
}

/// A running (or finished) shell in a terminal. Cloning gives another
/// handle to the same terminal.
#[derive(Clone)]
pub struct Terminal {
    inner: Arc<Inner>,
}

struct Inner {
    shared: Arc<Shared>,
    term: Arc<Mutex<Term<Listener>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exit: Mutex<Option<Option<i32>>>,
    exited: Condvar,
    pid: Option<u32>,
    palette: Mutex<Palette>,
}

/// What the emulator's event listener needs: replies go back to the shell.
struct Shared {
    writer: Mutex<Box<dyn Write + Send>>,
    notify: Box<dyn Fn(Notice) + Send + Sync>,
    title: Mutex<String>,
    size: Mutex<(u16, u16)>,
    dirty: AtomicBool,
}

impl Shared {
    fn write(&self, bytes: &[u8]) {
        let mut w = self.writer.lock().unwrap();
        if let Err(e) = w.write_all(bytes).and_then(|_| w.flush()) {
            tracing::debug!("terminal write failed: {e}");
        }
    }
}

#[derive(Clone)]
struct Listener(Arc<Shared>);

impl EventListener for Listener {
    fn send_event(&self, event: TermEvent) {
        let s = &self.0;
        match event {
            // Answers to the program's questions (cursor position, device
            // attributes, …) go straight back to it.
            TermEvent::PtyWrite(text) => s.write(text.as_bytes()),
            TermEvent::Title(t) => {
                *s.title.lock().unwrap() = t.clone();
                (s.notify)(Notice::Title(t));
            }
            TermEvent::ResetTitle => {
                s.title.lock().unwrap().clear();
                (s.notify)(Notice::Title(String::new()));
            }
            TermEvent::Bell => (s.notify)(Notice::Bell),
            TermEvent::ClipboardStore(_, text) => (s.notify)(Notice::Clipboard(text)),
            TermEvent::TextAreaSizeRequest(reply) => {
                let (cols, rows) = *s.size.lock().unwrap();
                s.write(reply(WindowSize { num_lines: rows, num_cols: cols, cell_width: 8, cell_height: 16 }).as_bytes());
            }
            // Reading the clipboard from a program is refused: a program
            // shouldn't see what the user copied elsewhere.
            _ => {}
        }
    }
}

/// The emulator's idea of the size.
struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Where some text was found: a grid line (0 is the top of the screen,
/// negative lines are in the history), the column it starts at, and how
/// many columns it covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match {
    pub line: i32,
    pub col: usize,
    pub len: usize,
}

/// Lines of history kept above the screen.
pub const SCROLLBACK: usize = 10_000;

impl Terminal {
    /// Starts `cmd` in a new pseudo-terminal of `cols × rows`. `notify` is
    /// called from the terminal's threads.
    pub fn spawn(cmd: TerminalCommand, cols: u16, rows: u16, notify: impl Fn(Notice) + Send + Sync + 'static) -> Result<Terminal, SpawnError> {
        let (cols, rows) = (cols.max(2), rows.max(1));
        if let Some(dir) = &cmd.cwd {
            if !dir.is_dir() {
                return Err(SpawnError::NotAFolder(dir.clone()));
            }
        }
        allow_ctrl_c();
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| SpawnError::Pty(e.to_string()))?;

        let mut builder = CommandBuilder::new(&cmd.program);
        builder.args(&cmd.args);
        if let Some(dir) = &cmd.cwd {
            builder.cwd(dir);
        }
        // portable-pty starts Windows shells with the environment from the
        // registry; a terminal should get OXIS's own (as a process from the
        // Run view does), so PATH and friends match what OXIS was given.
        for (k, v) in std::env::vars_os() {
            builder.env(k, v);
        }
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");
        builder.env("TERM_PROGRAM", "OXIS");
        for (k, v) in &cmd.env {
            builder.env(k, v);
        }
        let mut child =
            pair.slave.spawn_command(builder).map_err(|e| SpawnError::Start { program: cmd.program.display().to_string(), message: e.to_string() })?;
        // The shell has its end; ours must go, or reads never see the end.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(|e| SpawnError::Pty(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| SpawnError::Pty(e.to_string()))?;
        let shared = Arc::new(Shared {
            writer: Mutex::new(writer),
            notify: Box::new(notify),
            title: Mutex::new(String::new()),
            size: Mutex::new((cols, rows)),
            dirty: AtomicBool::new(false),
        });
        let config = Config { scrolling_history: SCROLLBACK, ..Config::default() };
        let term = Arc::new(Mutex::new(Term::new(config, &Size { cols: cols as usize, rows: rows as usize }, Listener(shared.clone()))));
        let inner = Arc::new(Inner {
            shared: shared.clone(),
            term: term.clone(),
            killer: Mutex::new(child.clone_killer()),
            pid: child.process_id(),
            master: Mutex::new(Some(pair.master)),
            exit: Mutex::new(None),
            exited: Condvar::new(),
            palette: Mutex::new(Palette::default()),
        });

        let (done_tx, done_rx) = crossbeam_channel::bounded::<()>(1);
        {
            let shared = shared.clone();
            thread::Builder::new()
                .name("terminal-read".into())
                .spawn(move || {
                    read_into(reader, &term, &shared);
                    let _ = done_tx.send(());
                })
                .map_err(|e| SpawnError::Pty(e.to_string()))?;
        }
        {
            let inner = Arc::downgrade(&inner);
            let shared = shared.clone();
            thread::Builder::new()
                .name("terminal-wait".into())
                .spawn(move || {
                    let code = child.wait().ok().map(|s| s.exit_code() as i32);
                    // On Unix the reader sees the end as soon as the shell
                    // and its children are gone. ConPTY only ends the
                    // output when the pseudo-console is closed, so give the
                    // last output a moment, then close it.
                    if done_rx.recv_timeout(Duration::from_millis(250)).is_err() {
                        if let Some(i) = inner.upgrade() {
                            i.master.lock().unwrap().take();
                        }
                        let _ = done_rx.recv_timeout(Duration::from_secs(2));
                    }
                    if let Some(i) = inner.upgrade() {
                        i.master.lock().unwrap().take();
                        *i.exit.lock().unwrap() = Some(code);
                        i.exited.notify_all();
                    }
                    shared.dirty.store(true, Ordering::SeqCst);
                    (shared.notify)(Notice::Exited(code));
                })
                .map_err(|e| SpawnError::Pty(e.to_string()))?;
        }
        Ok(Terminal { inner })
    }

    /// Sends input, as the user typing it.
    pub fn write(&self, bytes: &[u8]) {
        if self.inner.exit.lock().unwrap().is_none() {
            // Typing scrolls back to the bottom, like every terminal.
            self.inner.term.lock().unwrap().scroll_display(Scroll::Bottom);
            self.inner.shared.write(bytes);
        }
    }

    /// Pastes text: wrapped in bracketed-paste markers when the program
    /// asked for them (so it isn't run line by line), and with any escape
    /// characters removed so a paste can't fake keystrokes.
    pub fn paste(&self, text: &str) {
        let clean: String = text.chars().filter(|c| *c != '\x1b').collect();
        if self.mode().contains(TermMode::BRACKETED_PASTE) {
            self.write(format!("\x1b[200~{clean}\x1b[201~").as_bytes());
        } else {
            self.write(clean.replace("\r\n", "\r").replace('\n', "\r").as_bytes());
        }
    }

    /// Changes the size, telling both the emulator and the shell.
    pub fn resize(&self, cols: u16, rows: u16) {
        let (cols, rows) = (cols.max(2), rows.max(1));
        {
            let mut size = self.inner.shared.size.lock().unwrap();
            if *size == (cols, rows) {
                return;
            }
            *size = (cols, rows);
        }
        self.inner.term.lock().unwrap().resize(Size { cols: cols as usize, rows: rows as usize });
        if let Some(m) = self.inner.master.lock().unwrap().as_ref() {
            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
        self.inner.shared.dirty.store(true, Ordering::SeqCst);
    }

    pub fn size(&self) -> (u16, u16) {
        *self.inner.shared.size.lock().unwrap()
    }

    /// Scrolls the view through the history: positive is up (older).
    pub fn scroll(&self, lines: i32) {
        self.inner.term.lock().unwrap().scroll_display(Scroll::Delta(lines));
        self.changed();
    }

    /// Every place `needle` appears in the history and on the screen,
    /// ignoring case, oldest first. Lines wrapped by the terminal are
    /// searched as they're shown (a match can't span a wrap).
    pub fn find(&self, needle: &str) -> Vec<Match> {
        let needle: Vec<char> = needle.to_lowercase().chars().collect();
        if needle.is_empty() {
            return Vec::new();
        }
        let term = self.inner.term.lock().unwrap();
        let grid = term.grid();
        let cols = grid.columns();
        let mut found = Vec::new();
        for line in grid.topmost_line().0..=grid.bottommost_line().0 {
            let row = &grid[Line(line)];
            // The row's characters with the column each starts at (wide
            // characters take two columns, their spacer none).
            let mut chars: Vec<(char, usize)> = Vec::with_capacity(cols);
            for col in 0..cols {
                let cell = &row[Column(col)];
                if cell.flags.intersects(alacritty_terminal::term::cell::Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                for lc in cell.c.to_lowercase() {
                    chars.push((lc, col));
                }
            }
            if chars.len() < needle.len() {
                continue;
            }
            let mut i = 0;
            while i + needle.len() <= chars.len() {
                if chars[i..i + needle.len()].iter().map(|(c, _)| *c).eq(needle.iter().copied()) {
                    let start = chars[i].1;
                    let end = chars[i + needle.len() - 1].1;
                    found.push(Match { line, col: start, len: end - start + 1 });
                    i += needle.len();
                } else {
                    i += 1;
                }
            }
        }
        found
    }

    /// Scrolls so that grid line `line` (negative: in the history) is on
    /// screen, about a third of the way down.
    pub fn reveal(&self, line: i32) {
        let mut term = self.inner.term.lock().unwrap();
        let rows = term.screen_lines() as i32;
        let history = term.grid().history_size() as i32;
        // The display offset that puts `line` a third of the way down.
        let want = (rows / 3 - line).clamp(0, history);
        let now = term.grid().display_offset() as i32;
        term.scroll_display(Scroll::Delta(want - now));
        drop(term);
        self.changed();
    }

    pub fn scroll_to_bottom(&self) {
        self.inner.term.lock().unwrap().scroll_display(Scroll::Bottom);
        self.changed();
    }

    /// Selects from one visible cell to another (row, column), inclusive.
    pub fn select(&self, from: (usize, usize), to: (usize, usize)) {
        let mut term = self.inner.term.lock().unwrap();
        let offset = term.grid().display_offset() as i32;
        let point = |(r, c): (usize, usize)| Point::new(Line(r as i32 - offset), Column(c));
        let mut sel = Selection::new(SelectionType::Simple, point(from), Side::Left);
        sel.update(point(to), Side::Right);
        term.selection = Some(sel);
        drop(term);
        self.changed();
    }

    pub fn clear_selection(&self) {
        self.inner.term.lock().unwrap().selection = None;
        self.changed();
    }

    /// The selected text, if anything is selected.
    pub fn selection_text(&self) -> Option<String> {
        self.inner.term.lock().unwrap().selection_to_string().filter(|s| !s.is_empty())
    }

    /// Whether the program asked for application cursor keys (which
    /// changes how arrows are sent; see [`crate::keys::encode`]).
    pub fn app_cursor(&self) -> bool {
        self.mode().contains(TermMode::APP_CURSOR)
    }

    /// Whether a full-screen program (an editor, a pager) is showing.
    pub fn alt_screen(&self) -> bool {
        self.mode().contains(TermMode::ALT_SCREEN)
    }

    fn mode(&self) -> TermMode {
        *self.inner.term.lock().unwrap().mode()
    }

    pub fn title(&self) -> String {
        self.inner.shared.title.lock().unwrap().clone()
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    /// `None` while the shell runs; then its exit code (if it has one).
    pub fn exit_status(&self) -> Option<Option<i32>> {
        *self.inner.exit.lock().unwrap()
    }

    /// Waits up to `timeout` for the shell to exit.
    pub fn wait(&self, timeout: Duration) -> Option<Option<i32>> {
        let deadline = Instant::now() + timeout;
        let mut exit = self.inner.exit.lock().unwrap();
        while exit.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            exit = self.inner.exited.wait_timeout(exit, left).unwrap().0;
        }
        *exit
    }

    /// Ends the shell and what runs in it: the shell is killed and the
    /// pseudo-terminal closed, which hangs up on everything attached to it.
    pub fn kill(&self) {
        if self.exit_status().is_some() {
            return;
        }
        let _ = self.inner.killer.lock().unwrap().kill();
        self.inner.master.lock().unwrap().take();
    }

    pub fn set_palette(&self, palette: Palette) {
        *self.inner.palette.lock().unwrap() = palette;
        self.inner.shared.dirty.store(true, Ordering::SeqCst);
    }

    /// Marks the view as changed (scrolled, selected): what's visible is
    /// different even though the program printed nothing.
    fn changed(&self) {
        self.inner.shared.dirty.store(true, Ordering::SeqCst);
    }

    /// Whether the screen changed since the last [`take_dirty`](Self::take_dirty).
    pub fn is_dirty(&self) -> bool {
        self.inner.shared.dirty.load(Ordering::SeqCst)
    }

    /// Whether the screen changed since this was last called, clearing the
    /// mark. Meant for the one thing that draws the terminal: it re-reads
    /// the screen when this says so. Reading [`screen`](Self::screen)
    /// elsewhere (a test, a search) doesn't touch the mark, so it can't make
    /// the drawing miss a change.
    pub fn take_dirty(&self) -> bool {
        self.inner.shared.dirty.swap(false, Ordering::SeqCst)
    }

    /// What's visible now.
    pub fn screen(&self) -> Screen {
        let palette = self.inner.palette.lock().unwrap().clone();
        let term = self.inner.term.lock().unwrap();
        let content = term.renderable_content();
        let (cols, rows) = (term.columns(), term.screen_lines());
        let offset = content.display_offset as i32;
        let blank = Cell { ch: ' ', fg: palette.foreground, bg: palette.background, flags: CellFlags::default() };
        let mut cells = vec![blank; cols * rows];
        let selection = content.selection;
        for item in content.display_iter {
            let row = item.point.line.0 + offset;
            if row < 0 || row as usize >= rows || item.point.column.0 >= cols {
                continue;
            }
            let c = item.cell;
            let bold = c.flags.contains(alacritty_terminal::term::cell::Flags::BOLD);
            let mut fg = palette.resolve(c.fg, content.colors, bold);
            let mut bg = palette.resolve(c.bg, content.colors, false);
            let f = c.flags;
            use alacritty_terminal::term::cell::Flags as F;
            if f.contains(F::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            if f.contains(F::DIM) {
                fg = std::array::from_fn(|i| ((fg[i] as u16 * 2 + bg[i] as u16) / 3) as u8);
            }
            if f.contains(F::HIDDEN) {
                fg = bg;
            }
            let selected = selection.is_some_and(|s| s.contains(item.point));
            cells[row as usize * cols + item.point.column.0] = Cell { ch: c.c, fg, bg, flags: CellFlags::from_cell(f, selected) };
        }
        let cursor = if content.cursor.shape == VteCursor::Hidden || !content.mode.contains(TermMode::SHOW_CURSOR) {
            None
        } else {
            let row = content.cursor.point.line.0 + offset;
            let shape = match content.cursor.shape {
                VteCursor::Underline => CursorShape::Underline,
                VteCursor::Beam => CursorShape::Beam,
                _ => CursorShape::Block,
            };
            (row >= 0 && (row as usize) < rows).then_some((row as usize, content.cursor.point.column.0.min(cols - 1), shape))
        };
        Screen { cols, rows, cells, cursor, scrolled: content.display_offset, history: term.grid().history_size(), background: palette.background }
    }
}

/// Feeds the shell's output into the emulator until the output ends.
fn read_into(mut reader: Box<dyn Read + Send>, term: &Mutex<Term<Listener>>, shared: &Shared) {
    let mut parser: Processor = Processor::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                parser.advance(&mut *term.lock().unwrap(), &buf[..n]);
                if !shared.dirty.swap(true, Ordering::SeqCst) {
                    (shared.notify)(Notice::Output);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // The last handle is gone: don't leave the shell running.
        if self.exit.get_mut().map(|e| e.is_none()).unwrap_or(false) {
            if let Ok(k) = self.killer.get_mut() {
                let _ = k.kill();
            }
        }
    }
}

/// Windows passes "ignore Ctrl+C" down from process to process: if
/// whatever started OXIS set it (some launchers and test runners do),
/// every shell OXIS starts would ignore Ctrl+C too, and a running command
/// couldn't be interrupted. Restoring normal handling once, before the
/// first terminal, means shells get it.
#[cfg(windows)]
fn allow_ctrl_c() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
    });
}

#[cfg(not(windows))]
fn allow_ctrl_c() {}
