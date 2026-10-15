//! Terminals for the OXIDE Engine: a real shell in a pseudo-terminal
//! (ConPTY on Windows, a Unix PTY elsewhere), emulated by
//! `alacritty_terminal`.
//!
//! This crate knows nothing about workspaces or the interface. A
//! [`Terminal`] is one shell: it reads the shell's output on its own thread
//! into the emulator, and anyone holding it can write input, resize it,
//! scroll, select and copy, and take a [`Screen`] — a plain snapshot of
//! what's visible, with colours resolved — to draw. Session ownership,
//! IDs and events live in the engine (`oxide::terminal`).
//!
//! - [`shells`] finds the shells installed on this machine.
//! - [`keys`] turns key presses into the bytes a terminal expects.

pub mod keys;
mod screen;
pub mod shells;
mod terminal;

pub use screen::{Cell, CellFlags, CursorShape, Palette, Screen};
pub use terminal::{Match, Notice, SpawnError, Terminal, TerminalCommand};
