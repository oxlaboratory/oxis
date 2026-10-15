//! The event bus. Engines publish what happened; the interface, Lua and
//! other engines subscribe. Each subscriber gets its own unbounded channel,
//! so a slow reader never blocks a publisher. A subscriber that has been
//! dropped is removed the next time an event is published.

use std::sync::{Arc, Mutex};

use crossbeam_channel::{unbounded, Receiver, Sender};

use crate::ids::{ProcessId, SessionId, WorkspaceId};

/// Which stream a line of process output came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    WorkspaceCreated {
        id: WorkspaceId,
        name: String,
    },
    WorkspaceOpened {
        id: WorkspaceId,
        name: String,
    },
    WorkspaceClosed {
        id: WorkspaceId,
        name: String,
    },
    WorkspaceRenamed {
        id: WorkspaceId,
        from: String,
        to: String,
    },
    /// A workspace was taken out of OXIS (its record kept under `.removed`).
    WorkspaceRemoved {
        name: String,
    },
    /// The active workspace changed (None: no workspace is active).
    WorkspaceActivated {
        id: Option<WorkspaceId>,
    },

    ProcessStarted {
        id: ProcessId,
        owner: Option<WorkspaceId>,
        command: String,
    },
    /// One line of output, without its line ending.
    ProcessOutput {
        id: ProcessId,
        stream: Stream,
        line: String,
    },
    /// The process ended. `code` is its exit code; None when it was killed
    /// by a signal or the code couldn't be read. `cancelled` says OXIS
    /// stopped it.
    ProcessExited {
        id: ProcessId,
        code: Option<i32>,
        cancelled: bool,
    },

    /// A terminal session started (its shell is running).
    SessionStarted {
        id: SessionId,
        owner: Option<WorkspaceId>,
        label: String,
    },
    /// The session's screen changed. Sent once per change however much
    /// output arrived, until whoever draws it takes the change
    /// (`Terminal::take_dirty`).
    SessionOutput {
        id: SessionId,
    },
    /// The program in the session set its title (empty: reset).
    SessionTitle {
        id: SessionId,
        title: String,
    },
    SessionBell {
        id: SessionId,
    },
    /// The program asked to put text on the clipboard (OSC 52).
    SessionClipboard {
        id: SessionId,
        text: String,
    },
    /// The session's shell exited. The session stays (its screen can still
    /// be read) until it's closed.
    SessionExited {
        id: SessionId,
        code: Option<i32>,
    },
    SessionClosed {
        id: SessionId,
    },
}

/// A cheap-to-clone handle to the bus.
#[derive(Clone, Default)]
pub struct EventBus {
    subscribers: Arc<Mutex<Vec<Sender<Event>>>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new subscriber: every event published from now on arrives here.
    pub fn subscribe(&self) -> Receiver<Event> {
        let (tx, rx) = unbounded();
        self.subscribers.lock().expect("event bus poisoned").push(tx);
        rx
    }

    pub fn publish(&self, event: Event) {
        let mut subs = self.subscribers.lock().expect("event bus poisoned");
        subs.retain(|tx| tx.send(event.clone()).is_ok());
    }

    /// How many subscribers are still listening (dropped ones are counted
    /// until the next publish).
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.lock().expect("event bus poisoned").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_subscriber_gets_every_event() {
        let bus = EventBus::new();
        let a = bus.subscribe();
        let b = bus.subscribe();
        let id = WorkspaceId::next();
        bus.publish(Event::WorkspaceActivated { id: Some(id) });
        assert_eq!(a.try_recv().unwrap(), Event::WorkspaceActivated { id: Some(id) });
        assert_eq!(b.try_recv().unwrap(), Event::WorkspaceActivated { id: Some(id) });
    }

    #[test]
    fn dropped_subscribers_are_forgotten() {
        let bus = EventBus::new();
        let a = bus.subscribe();
        {
            let _gone = bus.subscribe();
        }
        bus.publish(Event::WorkspaceActivated { id: None });
        assert_eq!(bus.subscriber_count(), 1);
        assert!(a.try_recv().is_ok());
    }
}
