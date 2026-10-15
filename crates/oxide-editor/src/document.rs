//! One document: its text, where it came from, the cursor, and its history.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ropey::Rope;
use unicode_segmentation::UnicodeSegmentation;

use crate::encoding::{self, Encoding, LineEnding};
use crate::{Error, Result};

/// Files larger than this aren't opened as text.
pub const MAX_MB: u64 = 256;

/// A span of the text, in characters: `start..end`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

impl Range {
    pub fn new(a: usize, b: usize) -> Self {
        Self { start: a.min(b), end: a.max(b) }
    }
    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
    pub fn len(&self) -> usize {
        self.end - self.start
    }
}

/// The cursor and its selection: the selection runs from `anchor` to
/// `head`; the cursor is at `head`. `goal` is the column the cursor aims
/// for when moving up and down through shorter lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Cursor {
    pub head: usize,
    pub anchor: usize,
    goal: Option<usize>,
}

impl Cursor {
    pub fn at(pos: usize) -> Self {
        Self { head: pos, anchor: pos, goal: None }
    }
    pub fn selection(&self) -> Range {
        Range::new(self.anchor, self.head)
    }
}

/// How the file is indented: found from its text when it's opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Indent {
    Tabs,
    Spaces(usize),
}

impl Indent {
    pub fn unit(self) -> String {
        match self {
            Indent::Tabs => "\t".to_owned(),
            Indent::Spaces(n) => " ".repeat(n),
        }
    }
    pub fn width(self) -> usize {
        match self {
            Indent::Tabs => 4,
            Indent::Spaces(n) => n,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Movement {
    Left,
    Right,
    Up,
    Down,
    WordLeft,
    WordRight,
    /// To the first non-blank character, or column 0 if already there.
    LineStart,
    LineEnd,
    PageUp(usize),
    PageDown(usize),
    DocStart,
    DocEnd,
}

/// One change: `removed` was at `at`, and `inserted` replaced it.
#[derive(Clone, Debug)]
struct Edit {
    at: usize,
    removed: String,
    inserted: String,
}

/// Edits undone and redone together, with the cursor before and after.
#[derive(Clone, Debug)]
struct Group {
    edits: Vec<Edit>,
    before: Cursor,
    after: Cursor,
    /// Typing a word: later typing joins this group.
    typing: bool,
    at: Instant,
}

pub struct Document {
    text: Rope,
    path: Option<PathBuf>,
    pub encoding: Encoding,
    pub line_ending: LineEnding,
    pub indent: Indent,
    pub cursor: Cursor,
    undo: Vec<Group>,
    redo: Vec<Group>,
    /// Bumped by every change, undo and redo; `saved` is its value at the
    /// last open or save.
    version: u64,
    saved: u64,
}

impl Default for Document {
    fn default() -> Self {
        Self::from_text("")
    }
}

impl Document {
    /// A new, unsaved document.
    pub fn from_text(text: &str) -> Self {
        let (text, line_ending) = encoding::normalize(text);
        let indent = detect_indent(&text);
        Self {
            text: Rope::from_str(&text),
            path: None,
            encoding: Encoding::Utf8,
            line_ending,
            indent,
            cursor: Cursor::default(),
            undo: Vec::new(),
            redo: Vec::new(),
            version: 0,
            saved: 0,
        }
    }

    /// Opens a file as text.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let read_err = |source| Error::Read { path: path.to_owned(), source };
        let size = std::fs::metadata(path).map_err(read_err)?.len();
        if size > MAX_MB * 1024 * 1024 {
            return Err(Error::TooLarge { path: path.to_owned(), size: size / (1024 * 1024), limit: MAX_MB });
        }
        let bytes = std::fs::read(path).map_err(read_err)?;
        let (text, encoding) = encoding::decode(&bytes).ok_or_else(|| Error::Binary(path.to_owned()))?;
        let mut doc = Self::from_text(&text);
        doc.encoding = encoding;
        doc.path = Some(path.to_owned());
        Ok(doc)
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The file name, or "Untitled".
    pub fn title(&self) -> String {
        self.path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into())
    }

    /// Saves to the document's file, in its encoding and line ending. The
    /// file is replaced atomically (a temporary file, then a rename), so a
    /// failed save never leaves half a file.
    pub fn save(&mut self) -> Result<()> {
        let path = self.path.clone().ok_or(Error::NoPath)?;
        self.save_as(path)
    }

    pub fn save_as(&mut self, path: impl Into<PathBuf>) -> Result<()> {
        let path = path.into();
        let mut text = self.text.to_string();
        if self.line_ending == LineEnding::CrLf {
            text = text.replace('\n', "\r\n");
        }
        let bytes = encoding::encode(&text, self.encoding);
        write_atomic(&path, &bytes).map_err(|source| Error::Write { path: path.clone(), source })?;
        self.path = Some(path);
        self.saved = self.version;
        Ok(())
    }

    /// Whether there are changes since it was opened or last saved.
    pub fn is_modified(&self) -> bool {
        self.version != self.saved
    }

    // ── reading ────────────────────────────────────────────────────────

    /// The whole text, with `\n` line endings.
    pub fn text(&self) -> String {
        self.text.to_string()
    }

    pub fn len_chars(&self) -> usize {
        self.text.len_chars()
    }

    pub fn line_count(&self) -> usize {
        self.text.len_lines()
    }

    /// One line, without its line ending.
    pub fn line(&self, i: usize) -> String {
        if i >= self.text.len_lines() {
            return String::new();
        }
        let mut s = self.text.line(i).to_string();
        if s.ends_with('\n') {
            s.pop();
        }
        s
    }

    /// The line and column (both from 0, column in characters) of a position.
    pub fn line_col(&self, pos: usize) -> (usize, usize) {
        let pos = pos.min(self.text.len_chars());
        let line = self.text.char_to_line(pos);
        (line, pos - self.text.line_to_char(line))
    }

    /// The position of a line and column (clamped to the line).
    pub fn pos(&self, line: usize, col: usize) -> usize {
        let line = line.min(self.text.len_lines().saturating_sub(1));
        let start = self.text.line_to_char(line);
        start + col.min(self.line_len(line))
    }

    fn line_len(&self, line: usize) -> usize {
        self.line(line).chars().count()
    }

    pub fn slice(&self, r: Range) -> String {
        self.text.slice(r.start.min(self.len_chars())..r.end.min(self.len_chars())).to_string()
    }

    /// The selected text (empty if nothing is selected).
    pub fn selected_text(&self) -> String {
        self.slice(self.cursor.selection())
    }

    // ── editing ────────────────────────────────────────────────────────

    /// Replaces `range` with `text`, recording it for undo. Everything that
    /// changes the text goes through here.
    fn replace(&mut self, range: Range, text: &str, typing: bool) {
        let before = self.cursor;
        let removed = self.slice(range);
        if removed.is_empty() && text.is_empty() {
            return;
        }
        self.text.remove(range.start..range.end);
        self.text.insert(range.start, text);
        let end = range.start + text.chars().count();
        self.cursor = Cursor::at(end);
        let edit = Edit { at: range.start, removed, inserted: text.to_owned() };
        self.version += 1;
        self.redo.clear();
        // Typing one word joins the group before it, if it follows on.
        if typing {
            if let Some(last) = self.undo.last_mut() {
                let follows = last.typing && last.after == before && last.at.elapsed() < Duration::from_secs(2);
                if follows {
                    last.edits.push(edit);
                    last.after = self.cursor;
                    last.at = Instant::now();
                    return;
                }
            }
        }
        self.undo.push(Group { edits: vec![edit], before, after: self.cursor, typing, at: Instant::now() });
    }

    /// Types `text` at the cursor, replacing the selection. Enter keeps the
    /// line's indentation.
    pub fn insert(&mut self, text: &str) {
        let sel = self.cursor.selection();
        if text == "\n" {
            let (line, _) = self.line_col(sel.start);
            let lead: String = self.line(line).chars().take_while(|c| *c == ' ' || *c == '\t').collect();
            self.replace(sel, &format!("\n{lead}"), false);
            return;
        }
        let word = text.chars().all(|c| c.is_alphanumeric() || c == '_') && sel.is_empty();
        let (text, _) = encoding::normalize(text);
        self.replace(sel, &text, word);
    }

    /// Inserts one level of indentation, or indents every selected line.
    pub fn tab(&mut self) {
        let sel = self.cursor.selection();
        let (l0, _) = self.line_col(sel.start);
        let (l1, _) = self.line_col(sel.end);
        if l0 != l1 {
            return self.indent_lines(true);
        }
        let unit = match self.indent {
            Indent::Tabs => "\t".to_owned(),
            Indent::Spaces(n) => {
                let (_, col) = self.line_col(sel.start);
                " ".repeat(n - col % n)
            }
        };
        self.replace(sel, &unit, false);
    }

    /// Indents (or, with `false`, outdents) every line the selection touches.
    pub fn indent_lines(&mut self, more: bool) {
        let sel = self.cursor.selection();
        let (l0, _) = self.line_col(sel.start);
        let (mut l1, c1) = self.line_col(sel.end);
        if l1 > l0 && c1 == 0 {
            l1 -= 1; // a selection ending at a line's start doesn't include it
        }
        let before = self.cursor;
        let unit = self.indent.unit();
        let width = self.indent.width();
        let mut edits = Vec::new();
        // Bottom to top, so earlier positions stay valid.
        for line in (l0..=l1).rev() {
            let start = self.text.line_to_char(line);
            let text = self.line(line);
            if more {
                if text.trim().is_empty() {
                    continue;
                }
                self.text.insert(start, &unit);
                edits.push(Edit { at: start, removed: String::new(), inserted: unit.clone() });
            } else {
                let n = if text.starts_with('\t') { 1 } else { text.chars().take(width).take_while(|c| *c == ' ').count() };
                if n > 0 {
                    let removed: String = text.chars().take(n).collect();
                    self.text.remove(start..start + n);
                    edits.push(Edit { at: start, removed, inserted: String::new() });
                }
            }
        }
        if edits.is_empty() {
            return;
        }
        // Keep the same lines selected, whole.
        let a = self.text.line_to_char(l0);
        let b = self.text.line_to_char(l1) + self.line_len(l1);
        self.cursor = Cursor { anchor: a, head: b, goal: None };
        self.version += 1;
        self.redo.clear();
        self.undo.push(Group { edits, before, after: self.cursor, typing: false, at: Instant::now() });
    }

    /// Deletes the selection, or the character before the cursor. In
    /// leading spaces, deletes back to the previous indentation stop.
    pub fn backspace(&mut self) {
        let sel = self.cursor.selection();
        if !sel.is_empty() {
            return self.replace(sel, "", false);
        }
        if sel.start == 0 {
            return;
        }
        let (line, col) = self.line_col(sel.start);
        if let Indent::Spaces(n) = self.indent {
            let lead = self.line(line).chars().take(col).all(|c| c == ' ');
            if lead && col > 0 {
                let back = match col % n {
                    0 => n,
                    r => r,
                };
                return self.replace(Range::new(sel.start - back, sel.start), "", false);
            }
        }
        let prev = self.prev_boundary(sel.start);
        self.replace(Range::new(prev, sel.start), "", false);
    }

    /// Deletes the selection, or the character after the cursor.
    pub fn delete(&mut self) {
        let sel = self.cursor.selection();
        if !sel.is_empty() {
            return self.replace(sel, "", false);
        }
        let next = self.next_boundary(sel.start);
        self.replace(Range::new(sel.start, next), "", false);
    }

    /// Removes and returns the selected text (for Cut).
    pub fn cut(&mut self) -> String {
        let text = self.selected_text();
        if !text.is_empty() {
            self.replace(self.cursor.selection(), "", false);
        }
        text
    }

    // ── undo ───────────────────────────────────────────────────────────

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn undo(&mut self) -> bool {
        let Some(group) = self.undo.pop() else { return false };
        for e in group.edits.iter().rev() {
            self.text.remove(e.at..e.at + e.inserted.chars().count());
            self.text.insert(e.at, &e.removed);
        }
        self.cursor = group.before;
        self.version += 1;
        self.redo.push(group);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(group) = self.redo.pop() else { return false };
        for e in &group.edits {
            self.text.remove(e.at..e.at + e.removed.chars().count());
            self.text.insert(e.at, &e.inserted);
        }
        self.cursor = group.after;
        self.version += 1;
        self.undo.push(Group { typing: false, ..group });
        true
    }

    // ── the cursor ─────────────────────────────────────────────────────

    /// Puts the cursor at `pos`; with `select`, extends the selection.
    pub fn set_cursor(&mut self, pos: usize, select: bool) {
        let pos = pos.min(self.len_chars());
        self.cursor = Cursor { head: pos, anchor: if select { self.cursor.anchor } else { pos }, goal: None };
    }

    pub fn select_all(&mut self) {
        self.cursor = Cursor { anchor: 0, head: self.len_chars(), goal: None };
    }

    pub fn select(&mut self, r: Range) {
        self.cursor = Cursor { anchor: r.start, head: r.end, goal: None };
    }

    /// Moves the cursor; with `select`, extends the selection.
    pub fn move_cursor(&mut self, m: Movement, select: bool) {
        let c = self.cursor;
        let sel = c.selection();
        let (line, col) = self.line_col(c.head);
        let goal = c.goal.unwrap_or(col);
        let (head, keep_goal) = match m {
            // Without Shift, Left and Right collapse a selection to its edge.
            Movement::Left if !select && !sel.is_empty() => (sel.start, false),
            Movement::Right if !select && !sel.is_empty() => (sel.end, false),
            Movement::Left => (self.prev_boundary(c.head), false),
            Movement::Right => (self.next_boundary(c.head), false),
            Movement::Up if line == 0 => (0, false),
            Movement::Up => (self.pos(line - 1, goal), true),
            Movement::Down if line + 1 >= self.line_count() => (self.len_chars(), false),
            Movement::Down => (self.pos(line + 1, goal), true),
            Movement::PageUp(n) => (self.pos(line.saturating_sub(n), goal), true),
            Movement::PageDown(n) => (self.pos((line + n).min(self.line_count() - 1), goal), true),
            Movement::WordLeft => (self.word_left(c.head), false),
            Movement::WordRight => (self.word_right(c.head), false),
            Movement::LineStart => {
                let first = self.line(line).chars().take_while(|c| c.is_whitespace()).count();
                (self.pos(line, if col == first { 0 } else { first }), false)
            }
            Movement::LineEnd => (self.pos(line, usize::MAX), false),
            Movement::DocStart => (0, false),
            Movement::DocEnd => (self.len_chars(), false),
        };
        self.cursor = Cursor { head, anchor: if select { c.anchor } else { head }, goal: keep_goal.then_some(goal) };
    }

    /// The position before `pos`, one user-perceived character back.
    fn prev_boundary(&self, pos: usize) -> usize {
        if pos == 0 {
            return 0;
        }
        let (line, col) = self.line_col(pos);
        if col == 0 {
            return pos - 1; // to the end of the previous line
        }
        let text = self.line(line);
        let mut last = 0;
        for (i, g) in text.graphemes(true).scan(0, |n, g| {
            let start = *n;
            *n += g.chars().count();
            Some((start, g))
        }) {
            let _ = g;
            if i >= col {
                break;
            }
            last = i;
        }
        pos - (col - last)
    }

    fn next_boundary(&self, pos: usize) -> usize {
        if pos >= self.len_chars() {
            return self.len_chars();
        }
        let (line, col) = self.line_col(pos);
        let text = self.line(line);
        let mut n = 0;
        for g in text.graphemes(true) {
            let len = g.chars().count();
            if n >= col {
                return pos + len;
            }
            n += len;
        }
        pos + 1 // the line ending
    }

    fn word_left(&self, pos: usize) -> usize {
        let chars: Vec<char> = self.text.slice(..pos).chars().collect();
        let mut i = chars.len();
        while i > 0 && chars[i - 1].is_whitespace() {
            i -= 1;
        }
        let word = |c: char| c.is_alphanumeric() || c == '_';
        if i > 0 && word(chars[i - 1]) {
            while i > 0 && word(chars[i - 1]) {
                i -= 1;
            }
        } else {
            // One punctuation character at a time.
            i = i.saturating_sub(1);
        }
        i
    }

    fn word_right(&self, pos: usize) -> usize {
        let len = self.len_chars();
        let chars: Vec<char> = self.text.slice(pos..).chars().collect();
        let mut i = 0;
        let word = |c: char| c.is_alphanumeric() || c == '_';
        if i < chars.len() && word(chars[i]) {
            while i < chars.len() && word(chars[i]) {
                i += 1;
            }
        } else if i < chars.len() && !chars[i].is_whitespace() {
            i += 1;
        }
        while i < chars.len() && chars[i].is_whitespace() && chars[i] != '\n' {
            i += 1;
        }
        (pos + i).min(len)
    }

    // ── search ─────────────────────────────────────────────────────────

    /// Every occurrence of `query`, in order.
    pub fn find(&self, query: &str, match_case: bool) -> Vec<Range> {
        if query.is_empty() {
            return Vec::new();
        }
        let fold = |s: &str| if match_case { s.to_owned() } else { s.to_lowercase() };
        let hay: Vec<char> = fold(&self.text()).chars().collect();
        let needle: Vec<char> = fold(query).chars().collect();
        // Lower-casing can change length for a few characters; the search
        // then works on the folded text, which is fine for the ASCII and
        // most of Unicode where it doesn't.
        let mut out = Vec::new();
        let mut i = 0;
        while i + needle.len() <= hay.len() {
            if hay[i..i + needle.len()] == needle[..] {
                out.push(Range { start: i, end: i + needle.len() });
                i += needle.len();
            } else {
                i += 1;
            }
        }
        out
    }

    /// Replaces every occurrence, as one undoable step. Returns how many.
    pub fn replace_all(&mut self, query: &str, with: &str, match_case: bool) -> usize {
        let found = self.find(query, match_case);
        if found.is_empty() {
            return 0;
        }
        let before = self.cursor;
        let mut edits = Vec::new();
        for r in found.iter().rev() {
            let removed = self.slice(*r);
            self.text.remove(r.start..r.end);
            self.text.insert(r.start, with);
            edits.push(Edit { at: r.start, removed, inserted: with.to_owned() });
        }
        self.cursor = Cursor::at(self.cursor.head.min(self.len_chars()));
        self.version += 1;
        self.redo.clear();
        self.undo.push(Group { edits, before, after: self.cursor, typing: false, at: Instant::now() });
        found.len()
    }
}

/// Spaces (2, 4 or 8) or tabs, by what most indented lines start with;
/// four spaces if nothing is indented.
fn detect_indent(text: &str) -> Indent {
    let (mut tabs, mut spaces) = (0, [0usize; 9]);
    let mut prev = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with('\t') {
            tabs += 1;
            continue;
        }
        let n = line.chars().take_while(|c| *c == ' ').count();
        // Count the step from the previous line's indentation, which is
        // the unit, not the depth.
        let step = n.abs_diff(prev);
        if (2..=8).contains(&step) {
            spaces[step] += 1;
        }
        prev = n;
    }
    let (best, count) = spaces.iter().enumerate().max_by_key(|(_, c)| **c).map(|(i, c)| (i, *c)).unwrap_or((4, 0));
    if tabs > count {
        Indent::Tabs
    } else if count == 0 {
        Indent::Spaces(4)
    } else {
        Indent::Spaces(best)
    }
}

/// Writes `bytes` to `path` through a temporary file in the same folder,
/// then renames it into place.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.oxis-save"));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}
