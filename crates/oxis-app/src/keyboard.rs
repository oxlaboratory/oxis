//! Window key presses to terminal input.

use oxide::terminal::keys::{Key, Mods};
use winit::event::{ElementState, KeyEvent};
use winit::keyboard::{Key as WKey, ModifiersState, NamedKey};

use crate::shell::TermInput;

/// What a key press means to a terminal, or `None` for keys a terminal
/// doesn't take (a lone Shift, media keys, releases).
pub fn term_input(event: &KeyEvent, m: ModifiersState) -> Option<TermInput> {
    if event.state != ElementState::Pressed {
        return None;
    }
    let mods = Mods { ctrl: m.control_key(), alt: m.alt_key(), shift: m.shift_key() };
    // AltGr arrives as Ctrl+Alt on Windows; what it types is plain text.
    let altgr_text = mods.ctrl && mods.alt && event.text.as_ref().is_some_and(|t| t.chars().all(|c| !c.is_control()));
    match &event.logical_key {
        WKey::Named(n) => {
            let key = match n {
                NamedKey::Enter => Key::Enter,
                NamedKey::Tab => Key::Tab,
                NamedKey::Backspace => Key::Backspace,
                NamedKey::Escape => Key::Escape,
                NamedKey::ArrowUp => Key::Up,
                NamedKey::ArrowDown => Key::Down,
                NamedKey::ArrowLeft => Key::Left,
                NamedKey::ArrowRight => Key::Right,
                NamedKey::Home => Key::Home,
                NamedKey::End => Key::End,
                NamedKey::PageUp => Key::PageUp,
                NamedKey::PageDown => Key::PageDown,
                NamedKey::Insert => Key::Insert,
                NamedKey::Delete => Key::Delete,
                NamedKey::Space => {
                    return Some(if (mods.ctrl || mods.alt) && !altgr_text { TermInput::Char(' ', mods) } else { TermInput::Text(" ".into()) });
                }
                NamedKey::F1 => Key::F(1),
                NamedKey::F2 => Key::F(2),
                NamedKey::F3 => Key::F(3),
                NamedKey::F4 => Key::F(4),
                NamedKey::F5 => Key::F(5),
                NamedKey::F6 => Key::F(6),
                NamedKey::F7 => Key::F(7),
                NamedKey::F8 => Key::F(8),
                NamedKey::F9 => Key::F(9),
                NamedKey::F10 => Key::F(10),
                NamedKey::F11 => Key::F(11),
                NamedKey::F12 => Key::F(12),
                _ => return None,
            };
            Some(TermInput::Key(key, mods))
        }
        WKey::Character(s) => {
            if (mods.ctrl || mods.alt) && !altgr_text {
                s.chars().next().map(|c| TermInput::Char(c, mods))
            } else {
                let text = event.text.as_ref().map(|t| t.to_string()).unwrap_or_else(|| s.to_string());
                (!text.is_empty()).then_some(TermInput::Text(text))
            }
        }
        _ => None,
    }
}
