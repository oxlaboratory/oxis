//! What a terminal shows, as plain data: the visible cells with their
//! colours already resolved, and the cursor. Taking a snapshot holds the
//! emulator's lock only while copying, so drawing never blocks the reader.

use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

/// The colours a terminal draws with: the 16 ANSI colours plus the default
/// foreground, background and cursor. Programs can still set any colour
/// directly (256-colour and true-colour sequences).
#[derive(Clone, Debug, PartialEq)]
pub struct Palette {
    pub ansi: [[u8; 3]; 16],
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub cursor: [u8; 3],
}

impl Default for Palette {
    /// The OXIS default theme.
    fn default() -> Self {
        Self {
            ansi: [
                [0x15, 0x16, 0x1e],
                [0xf7, 0x76, 0x8e],
                [0x2b, 0xb3, 0x5e],
                [0xe0, 0xaf, 0x68],
                [0x7a, 0xa2, 0xf7],
                [0xbb, 0x9a, 0xf7],
                [0x7d, 0xcf, 0xff],
                [0xa9, 0xb1, 0xd6],
                [0x41, 0x48, 0x68],
                [0xff, 0x7a, 0x93],
                [0x4f, 0xd4, 0x7f],
                [0xff, 0x9e, 0x64],
                [0x7d, 0xa6, 0xff],
                [0xc0, 0xa8, 0xff],
                [0xb4, 0xf9, 0xf8],
                [0xc0, 0xca, 0xf5],
            ],
            foreground: [0xc0, 0xca, 0xf5],
            background: [0x1a, 0x1b, 0x26],
            cursor: [0x4f, 0xd4, 0x7f],
        }
    }
}

impl Palette {
    /// One of the 256 indexed colours: the 16 ANSI ones, the 6×6×6 cube,
    /// then 24 greys.
    pub fn indexed(&self, i: u8) -> [u8; 3] {
        match i {
            0..=15 => self.ansi[i as usize],
            16..=231 => {
                let i = i - 16;
                let level = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
                [level(i / 36), level((i / 6) % 6), level(i % 6)]
            }
            232..=255 => {
                let v = 8 + (i - 232) * 10;
                [v, v, v]
            }
        }
    }

    pub(crate) fn resolve(&self, color: Color, overrides: &Colors, bold: bool) -> [u8; 3] {
        let rgb = |c: Rgb| [c.r, c.g, c.b];
        match color {
            Color::Spec(c) => rgb(c),
            Color::Indexed(i) => overrides[i as usize].map(rgb).unwrap_or_else(|| self.indexed(i)),
            Color::Named(n) => {
                let idx = n as usize;
                // Bold text in one of the first eight colours shows bright.
                let idx = if bold && idx < 8 { idx + 8 } else { idx };
                if let Some(c) = overrides[idx] {
                    return rgb(c);
                }
                match n {
                    NamedColor::Foreground | NamedColor::BrightForeground => self.foreground,
                    NamedColor::DimForeground => dim(self.foreground, self.background),
                    NamedColor::Background => self.background,
                    NamedColor::Cursor => self.cursor,
                    _ if idx < 16 => self.ansi[idx],
                    // DimBlack … DimWhite.
                    _ => dim(self.ansi[(idx - NamedColor::DimBlack as usize) % 8], self.background),
                }
            }
        }
    }
}

/// Two thirds of the way from `bg` to `fg`.
fn dim(fg: [u8; 3], bg: [u8; 3]) -> [u8; 3] {
    std::array::from_fn(|i| ((fg[i] as u16 * 2 + bg[i] as u16) / 3) as u8)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CellFlags(u8);

impl CellFlags {
    pub const BOLD: u8 = 1;
    pub const ITALIC: u8 = 2;
    pub const UNDERLINE: u8 = 4;
    pub const STRIKEOUT: u8 = 8;
    /// The right half of a double-width character: draw nothing.
    pub const SPACER: u8 = 16;
    /// The left half of a double-width character.
    pub const WIDE: u8 = 32;
    pub const SELECTED: u8 = 64;

    pub fn has(self, flag: u8) -> bool {
        self.0 & flag != 0
    }

    pub(crate) fn from_cell(f: Flags, selected: bool) -> Self {
        let mut v = 0;
        if f.contains(Flags::BOLD) {
            v |= Self::BOLD;
        }
        if f.contains(Flags::ITALIC) {
            v |= Self::ITALIC;
        }
        if f.intersects(Flags::ALL_UNDERLINES) {
            v |= Self::UNDERLINE;
        }
        if f.contains(Flags::STRIKEOUT) {
            v |= Self::STRIKEOUT;
        }
        if f.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            v |= Self::SPACER;
        }
        if f.contains(Flags::WIDE_CHAR) {
            v |= Self::WIDE;
        }
        if selected {
            v |= Self::SELECTED;
        }
        Self(v)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub fg: [u8; 3],
    pub bg: [u8; 3],
    pub flags: CellFlags,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Underline,
    Beam,
}

/// A snapshot of the visible part of a terminal.
#[derive(Clone, Debug)]
pub struct Screen {
    pub cols: usize,
    pub rows: usize,
    /// `rows × cols` cells, row by row.
    pub cells: Vec<Cell>,
    /// Row, column and shape — `None` when the program hid the cursor or
    /// the view is scrolled away from it.
    pub cursor: Option<(usize, usize, CursorShape)>,
    /// How many lines the view is scrolled back into the history.
    pub scrolled: usize,
    /// How many lines of history there are above the screen.
    pub history: usize,
    /// The background the whole terminal is cleared to.
    pub background: [u8; 3],
}

impl Screen {
    pub fn cell(&self, row: usize, col: usize) -> &Cell {
        &self.cells[row * self.cols + col]
    }

    /// One row as text, trailing blanks trimmed.
    pub fn line(&self, row: usize) -> String {
        let s: String = self.cells[row * self.cols..(row + 1) * self.cols].iter().filter(|c| !c.flags.has(CellFlags::SPACER)).map(|c| c.ch).collect();
        s.trim_end().to_owned()
    }

    /// Every row as text, trailing blank rows dropped.
    pub fn text(&self) -> String {
        let mut lines: Vec<String> = (0..self.rows).map(|r| self.line(r)).collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_colours() {
        let p = Palette::default();
        assert_eq!(p.indexed(1), p.ansi[1]);
        assert_eq!(p.indexed(16), [0, 0, 0]);
        assert_eq!(p.indexed(231), [255, 255, 255]);
        assert_eq!(p.indexed(196), [255, 0, 0]);
        assert_eq!(p.indexed(232), [8, 8, 8]);
        assert_eq!(p.indexed(255), [238, 238, 238]);
    }
}
