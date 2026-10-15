//! Key presses to terminal input, the way xterm encodes them (which is
//! what shells, editors and TUI programs expect).

/// A key that isn't plain text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Enter,
    Tab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    /// F1–F12.
    F(u8),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

impl Mods {
    pub const NONE: Mods = Mods { ctrl: false, alt: false, shift: false };
    pub const CTRL: Mods = Mods { ctrl: true, alt: false, shift: false };

    /// xterm's modifier parameter: 1 + shift + 2·alt + 4·ctrl.
    fn param(self) -> u8 {
        1 + self.shift as u8 + 2 * self.alt as u8 + 4 * self.ctrl as u8
    }

    fn any(self) -> bool {
        self.ctrl || self.alt || self.shift
    }
}

/// The bytes for a special key. `app_cursor` is the terminal's application
/// cursor mode (set by full-screen programs), which changes the arrows.
pub fn encode(key: Key, mods: Mods, app_cursor: bool) -> Vec<u8> {
    let csi_letter = |c: char| -> Vec<u8> {
        if mods.any() {
            format!("\x1b[1;{}{c}", mods.param()).into_bytes()
        } else if app_cursor {
            format!("\x1bO{c}").into_bytes()
        } else {
            format!("\x1b[{c}").into_bytes()
        }
    };
    let tilde = |n: u8| -> Vec<u8> {
        if mods.any() {
            format!("\x1b[{n};{}~", mods.param()).into_bytes()
        } else {
            format!("\x1b[{n}~").into_bytes()
        }
    };
    let alt = |bytes: &[u8]| -> Vec<u8> {
        let mut v = if mods.alt { vec![0x1b] } else { Vec::new() };
        v.extend_from_slice(bytes);
        v
    };
    match key {
        Key::Enter => alt(b"\r"),
        Key::Tab if mods.shift => b"\x1b[Z".to_vec(),
        Key::Tab => alt(b"\t"),
        Key::Backspace if mods.ctrl => alt(b"\x08"),
        Key::Backspace => alt(b"\x7f"),
        Key::Escape => alt(b"\x1b"),
        Key::Up => csi_letter('A'),
        Key::Down => csi_letter('B'),
        Key::Right => csi_letter('C'),
        Key::Left => csi_letter('D'),
        Key::Home => csi_letter('H'),
        Key::End => csi_letter('F'),
        Key::Insert => tilde(2),
        Key::Delete => tilde(3),
        Key::PageUp => tilde(5),
        Key::PageDown => tilde(6),
        Key::F(n @ 1..=4) => {
            let c = (b'P' + n - 1) as char;
            if mods.any() {
                format!("\x1b[1;{}{c}", mods.param()).into_bytes()
            } else {
                format!("\x1bO{c}").into_bytes()
            }
        }
        Key::F(n @ 5..=12) => tilde([15, 17, 18, 19, 20, 21, 23, 24][(n - 5) as usize]),
        Key::F(_) => Vec::new(),
    }
}

/// The bytes for a typed character with modifiers: Ctrl+letter is a
/// control code (Ctrl+C is 0x03), Alt prefixes ESC.
pub fn encode_char(c: char, mods: Mods) -> Vec<u8> {
    let mut out = Vec::new();
    if mods.alt {
        out.push(0x1b);
    }
    if mods.ctrl {
        let code = match c.to_ascii_lowercase() {
            l @ 'a'..='z' => Some(l as u8 - b'a' + 1),
            '@' | ' ' | '2' => Some(0),
            '[' | '3' => Some(0x1b),
            '\\' | '4' => Some(0x1c),
            ']' | '5' => Some(0x1d),
            '^' | '6' => Some(0x1e),
            '_' | '-' | '7' => Some(0x1f),
            '?' | '8' => Some(0x7f),
            _ => None,
        };
        if let Some(b) = code {
            out.push(b);
            return out;
        }
    }
    let mut buf = [0; 4];
    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrows_follow_the_cursor_mode_and_modifiers() {
        assert_eq!(encode(Key::Up, Mods::NONE, false), b"\x1b[A");
        assert_eq!(encode(Key::Up, Mods::NONE, true), b"\x1bOA");
        assert_eq!(encode(Key::Left, Mods::CTRL, true), b"\x1b[1;5D");
        assert_eq!(encode(Key::Right, Mods { shift: true, ..Mods::NONE }, false), b"\x1b[1;2C");
    }

    #[test]
    fn editing_and_function_keys() {
        assert_eq!(encode(Key::Enter, Mods::NONE, false), b"\r");
        assert_eq!(encode(Key::Backspace, Mods::NONE, false), b"\x7f");
        assert_eq!(encode(Key::Tab, Mods { shift: true, ..Mods::NONE }, false), b"\x1b[Z");
        assert_eq!(encode(Key::Delete, Mods::NONE, false), b"\x1b[3~");
        assert_eq!(encode(Key::Delete, Mods::CTRL, false), b"\x1b[3;5~");
        assert_eq!(encode(Key::F(1), Mods::NONE, false), b"\x1bOP");
        assert_eq!(encode(Key::F(5), Mods::NONE, false), b"\x1b[15~");
        assert_eq!(encode(Key::F(12), Mods::NONE, false), b"\x1b[24~");
    }

    #[test]
    fn control_and_alt_characters() {
        assert_eq!(encode_char('c', Mods::CTRL), [0x03]);
        assert_eq!(encode_char('C', Mods::CTRL), [0x03]);
        assert_eq!(encode_char('[', Mods::CTRL), [0x1b]);
        assert_eq!(encode_char('x', Mods { alt: true, ..Mods::NONE }), b"\x1bx");
        assert_eq!(encode_char('é', Mods::NONE), "é".as_bytes());
    }
}
