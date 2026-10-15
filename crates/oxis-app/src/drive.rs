//! Driving OXIS from a script, for end-to-end tests and documentation
//! screenshots.
//!
//! `oxis --drive <script> [WxH]` opens the window hidden, renders frames
//! offscreen, and feeds real input into the interface — the same mouse,
//! keyboard and text events a person produces, delivered to the same
//! widgets. Nothing is called behind the interface's back.
//!
//! A script is one step per line (`#` starts a comment):
//!
//! ```text
//! view run                 open a view (home, run, settings)
//! click nav:run            click a named control (see Shell::hotspot)
//! type echo hello          type text into whatever has the keyboard
//! key Enter                press a key: Enter, Escape, Tab, Ctrl+C, …
//! wait 500                 keep running for 500 ms
//! wait-idle 20000          wait until none of the active workspace's commands
//!                          is running (or fail)
//! wait-for started         wait until the latest command printed this line
//!                          (or fail after 20 s)
//! wait-screen text         wait until the focused terminal shows a line
//!                          containing this (or fail after 20 s)
//!
//! `type` and `key` go to the focused terminal when the Terminal view has
//! the keyboard, through the same path as keys from the window.
//! resize 900x600           resize the window
//! snapshot out.png         save the next frame as a PNG
//! dump state.json          write what's on screen and in the engine
//! ```
//!
//! The run ends after the last step; a step that can't be done (a control
//! that isn't on screen, a wait that times out) stops it with exit code 2.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use dear_imgui_rs::{Io, Key, MouseButton};

use crate::shell::{Shell, TermInput};

#[derive(Debug, Clone)]
pub enum Step {
    View(String),
    Click(String),
    Type(String),
    Key(String),
    Wait(Duration),
    WaitIdle(Duration),
    WaitFor(String),
    WaitScreen(String),
    /// Let a few frames render (layout settles, fonts upload).
    Frames(u32),
    Resize(u32, u32),
    Snapshot(PathBuf),
    Dump(PathBuf),
}

pub fn parse(script: &str) -> Result<Vec<Step>, String> {
    let mut steps = Vec::new();
    for (n, raw) in script.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (cmd, arg) = line.split_once(' ').map(|(c, a)| (c, a.trim())).unwrap_or((line, ""));
        let ms = |a: &str| a.parse::<u64>().map(Duration::from_millis).map_err(|_| format!("line {}: `{a}` isn't a number of milliseconds", n + 1));
        steps.push(match cmd {
            "view" => Step::View(arg.to_owned()),
            "click" => Step::Click(arg.to_owned()),
            "type" => Step::Type(arg.to_owned()),
            "key" => Step::Key(arg.to_owned()),
            "wait" => Step::Wait(ms(arg)?),
            "wait-for" => Step::WaitFor(arg.to_owned()),
            "wait-screen" => Step::WaitScreen(arg.to_owned()),
            "wait-idle" => Step::WaitIdle(ms(if arg.is_empty() { "20000" } else { arg })?),
            "frames" => Step::Frames(arg.parse().map_err(|_| format!("line {}: frames needs a number", n + 1))?),
            "resize" => {
                let (w, h) = parse_size(arg).ok_or_else(|| format!("line {}: resize needs WxH", n + 1))?;
                Step::Resize(w, h)
            }
            "snapshot" => Step::Snapshot(arg.into()),
            "dump" => Step::Dump(arg.into()),
            other => return Err(format!("line {}: unknown step `{other}`", n + 1)),
        });
    }
    Ok(steps)
}

pub fn parse_size(s: &str) -> Option<(u32, u32)> {
    let (w, h) = s.split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

enum Pending {
    None,
    MouseUp,
    KeysUp(Vec<Key>),
}

/// What the frame loop should do after a step.
pub enum After {
    Continue,
    Snapshot(PathBuf),
    Resize(u32, u32),
    Done,
    Failed(String),
}

enum Until {
    Time,
    Idle,
    Output(String),
    Screen(String),
}

pub struct Driver {
    steps: VecDeque<Step>,
    pending: Pending,
    waiting: Option<(Instant, Until)>,
    frames: u32,
}

impl Driver {
    pub fn new(steps: Vec<Step>) -> Self {
        Self { steps: steps.into(), pending: Pending::None, waiting: None, frames: 0 }
    }

    /// Feeds this frame's input, before the frame is built.
    pub fn before_frame(&mut self, io: &mut Io, shell: &mut Shell) -> After {
        match std::mem::replace(&mut self.pending, Pending::None) {
            Pending::MouseUp => {
                io.add_mouse_button_event(MouseButton::Left, false);
                return After::Continue;
            }
            Pending::KeysUp(keys) => {
                for k in keys.into_iter().rev() {
                    io.add_key_event(k, false);
                }
                return After::Continue;
            }
            Pending::None => {}
        }
        if self.frames > 0 {
            self.frames -= 1;
            return After::Continue;
        }
        if let Some((deadline, until)) = &self.waiting {
            let met = match until {
                Until::Time => false,
                Until::Idle => shell.running() == 0,
                Until::Output(text) => shell.latest_output_has(text),
                Until::Screen(text) => shell.terminal_screen_has(text),
            };
            if met {
                self.waiting = None;
            } else if Instant::now() < *deadline {
                return After::Continue;
            } else {
                let why = match until {
                    Until::Time => None,
                    Until::Idle => Some(format!("{} command(s) still running when wait-idle timed out", shell.running())),
                    Until::Output(text) => Some(format!("the latest command didn't print `{text}` in time")),
                    Until::Screen(text) => Some(format!("the terminal didn't show `{text}` in time")),
                };
                self.waiting = None;
                if let Some(why) = why {
                    return After::Failed(why);
                }
            }
        }
        let Some(step) = self.steps.pop_front() else {
            return After::Done;
        };
        tracing::info!(?step, "drive");
        match step {
            Step::View(v) => shell.set_view(&v),
            Step::Click(name) => {
                let Some(r) = shell.hotspot(&name) else {
                    return After::Failed(format!("there's no `{name}` on screen to click"));
                };
                io.add_mouse_pos_event([(r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0]);
                io.add_mouse_button_event(MouseButton::Left, true);
                self.pending = Pending::MouseUp;
            }
            Step::Type(text) if shell.terminal_has_keys() => {
                shell.terminal_input(TermInput::Text(text));
            }
            Step::Type(text) => io.add_input_characters_utf8(text),
            Step::Key(spec) if shell.terminal_has_keys() => match term_key(&spec) {
                Some(input) => {
                    shell.terminal_input(input);
                }
                None => return After::Failed(format!("unknown key `{spec}`")),
            },
            Step::Key(spec) => match keys(&spec) {
                Some(keys) => {
                    for k in &keys {
                        io.add_key_event(*k, true);
                    }
                    self.pending = Pending::KeysUp(keys);
                }
                None => return After::Failed(format!("unknown key `{spec}`")),
            },
            Step::Wait(d) => self.waiting = Some((Instant::now() + d, Until::Time)),
            Step::WaitIdle(d) => self.waiting = Some((Instant::now() + d, Until::Idle)),
            Step::WaitFor(text) => self.waiting = Some((Instant::now() + Duration::from_secs(20), Until::Output(text))),
            Step::WaitScreen(text) => self.waiting = Some((Instant::now() + Duration::from_secs(20), Until::Screen(text))),
            Step::Frames(n) => self.frames = n,
            Step::Resize(w, h) => {
                self.frames = 3;
                return After::Resize(w, h);
            }
            Step::Snapshot(path) => return After::Snapshot(path),
            Step::Dump(path) => {
                let text = serde_json::to_string_pretty(&shell.dump()).expect("JSON");
                if let Err(e) = std::fs::write(&path, text) {
                    return After::Failed(format!("couldn't write {}: {e}", path.display()));
                }
            }
        }
        After::Continue
    }
}

/// `Ctrl+C` → [ModCtrl, LeftCtrl, C]; `Enter` → [Enter].
fn keys(spec: &str) -> Option<Vec<Key>> {
    let mut out = Vec::new();
    for part in spec.split('+') {
        out.extend(match part.trim().to_ascii_lowercase().as_str() {
            "ctrl" => vec![Key::ModCtrl, Key::LeftCtrl],
            "shift" => vec![Key::ModShift, Key::LeftShift],
            "alt" => vec![Key::ModAlt, Key::LeftAlt],
            "enter" => vec![Key::Enter],
            "escape" | "esc" => vec![Key::Escape],
            "tab" => vec![Key::Tab],
            "backspace" => vec![Key::Backspace],
            "up" => vec![Key::UpArrow],
            "down" => vec![Key::DownArrow],
            "a" => vec![Key::A],
            "c" => vec![Key::C],
            "v" => vec![Key::V],
            "1" => vec![Key::Key1],
            "2" => vec![Key::Key2],
            "3" => vec![Key::Key3],
            "," | "comma" => vec![Key::Comma],
            _ => return None,
        });
    }
    Some(out)
}

/// `Ctrl+C` → Char('c', Ctrl); `Enter` → Key(Enter); `Shift+PageUp` → …
fn term_key(spec: &str) -> Option<TermInput> {
    use oxide::terminal::keys::{Key as K, Mods};
    let mut mods = Mods::NONE;
    let parts: Vec<&str> = spec.split('+').map(str::trim).collect();
    let (last, modifiers) = parts.split_last()?;
    for m in modifiers {
        match m.to_ascii_lowercase().as_str() {
            "ctrl" => mods.ctrl = true,
            "shift" => mods.shift = true,
            "alt" => mods.alt = true,
            _ => return None,
        }
    }
    let key = match last.to_ascii_lowercase().as_str() {
        "enter" => K::Enter,
        "tab" => K::Tab,
        "escape" | "esc" => K::Escape,
        "backspace" => K::Backspace,
        "up" => K::Up,
        "down" => K::Down,
        "left" => K::Left,
        "right" => K::Right,
        "home" => K::Home,
        "end" => K::End,
        "pageup" => K::PageUp,
        "pagedown" => K::PageDown,
        "delete" => K::Delete,
        s if s.chars().count() == 1 => return Some(TermInput::Char(s.chars().next()?, mods)),
        _ => return None,
    };
    Some(TermInput::Key(key, mods))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_script() {
        let steps = parse("# a test\nview run\n\ntype echo hi\nkey Ctrl+C\nwait 250\nwait-idle\nresize 900x600\nsnapshot a.png\n").unwrap();
        assert_eq!(steps.len(), 7);
        assert!(matches!(steps[3], Step::Wait(d) if d == Duration::from_millis(250)));
        assert!(matches!(steps[4], Step::WaitIdle(d) if d == Duration::from_secs(20)));
        assert!(matches!(steps[5], Step::Resize(900, 600)));
    }

    #[test]
    fn rejects_unknown_steps() {
        assert!(parse("teleport home").unwrap_err().contains("unknown step"));
        assert!(parse("wait soon").is_err());
        assert!(keys("Ctrl+Q").is_none());
        assert_eq!(keys("Ctrl+C").unwrap().len(), 3);
    }
}
