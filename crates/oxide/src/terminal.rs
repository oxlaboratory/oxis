//! Terminal sessions: real shells (see the `oxide-terminal` crate), each
//! with an ID and an owner. A workspace owns its sessions; closing it ends
//! them. What a session shows is read from its [`Terminal`]; that it
//! changed, got a title or ended arrives as [`Event`]s on the bus.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use oxide_terminal::Notice;
pub use oxide_terminal::{keys, shells, Cell, CellFlags, CursorShape, Palette, Screen, Terminal, TerminalCommand};

use crate::error::{Error, Result};
use crate::events::{Event, EventBus};
use crate::ids::{SessionId, WorkspaceId};

#[derive(Clone)]
pub struct Session {
    pub id: SessionId,
    pub owner: Option<WorkspaceId>,
    /// What started it (the shell's name), for tab labels until the
    /// program sets a title.
    pub label: String,
    pub terminal: Terminal,
}

pub struct Sessions {
    bus: EventBus,
    map: Arc<Mutex<BTreeMap<SessionId, Session>>>,
}

impl Sessions {
    pub fn new(bus: EventBus) -> Self {
        Self { bus, map: Arc::default() }
    }

    /// Starts `cmd` in a new session of `cols × rows`.
    pub fn open(&self, owner: Option<WorkspaceId>, label: impl Into<String>, cmd: TerminalCommand, cols: u16, rows: u16) -> Result<SessionId> {
        let id = SessionId::next();
        let bus = self.bus.clone();
        let program = cmd.program.display().to_string();
        let terminal = Terminal::spawn(cmd, cols, rows, move |n| {
            bus.publish(match n {
                Notice::Output => Event::SessionOutput { id },
                Notice::Title(title) => Event::SessionTitle { id, title },
                Notice::Bell => Event::SessionBell { id },
                Notice::Clipboard(text) => Event::SessionClipboard { id, text },
                Notice::Exited(code) => Event::SessionExited { id, code },
            })
        })
        .map_err(|e| match e {
            oxide_terminal::SpawnError::NotAFolder(p) => Error::NotAFolder(p),
            other => Error::Terminal { program, message: other.to_string() },
        })?;
        let label = label.into();
        self.map.lock().unwrap().insert(id, Session { id, owner, label: label.clone(), terminal });
        self.bus.publish(Event::SessionStarted { id, owner, label });
        Ok(id)
    }

    pub fn get(&self, id: SessionId) -> Option<Session> {
        self.map.lock().unwrap().get(&id).cloned()
    }

    /// The sessions a workspace owns (or, with `None`, those with no
    /// workspace), oldest first.
    pub fn owned_by(&self, owner: Option<WorkspaceId>) -> Vec<Session> {
        self.map.lock().unwrap().values().filter(|s| s.owner == owner).cloned().collect()
    }

    pub fn all(&self) -> Vec<Session> {
        self.map.lock().unwrap().values().cloned().collect()
    }

    /// Ends a session's shell and forgets the session.
    pub fn close(&self, id: SessionId) -> Result<()> {
        let s = self.map.lock().unwrap().remove(&id).ok_or(Error::NoSession(id))?;
        s.terminal.kill();
        self.bus.publish(Event::SessionClosed { id });
        Ok(())
    }

    /// Closes every session a workspace owns; returns how many.
    pub fn close_owned_by(&self, ws: WorkspaceId) -> usize {
        let ids: Vec<SessionId> = self.owned_by(Some(ws)).iter().map(|s| s.id).collect();
        for id in &ids {
            let _ = self.close(*id);
        }
        ids.len()
    }

    /// Ends every session (OXIS is closing).
    pub fn close_all(&self) {
        let ids: Vec<SessionId> = self.map.lock().unwrap().keys().copied().collect();
        for id in ids {
            let _ = self.close(id);
        }
    }
}
