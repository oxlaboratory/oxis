//! Typed identifiers. Each kind of thing the engine owns has its own ID
//! type, so a process ID can't be passed where a workspace ID is expected.
//! IDs are unique for the life of the process and never reused.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident, $prefix:literal) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
        pub struct $name(u64);

        impl $name {
            /// A new ID, never handed out before.
            pub fn next() -> Self {
                static NEXT: AtomicU64 = AtomicU64::new(1);
                Self(NEXT.fetch_add(1, Ordering::Relaxed))
            }

            pub fn raw(self) -> u64 {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!($prefix, "{}"), self.0)
            }
        }
    };
}

id_type!(
    /// A workspace open in this session.
    WorkspaceId, "ws"
);
id_type!(
    /// A process started by the process engine.
    ProcessId, "proc"
);
id_type!(
    /// A terminal session (a shell in a PTY).
    SessionId, "term"
);
id_type!(
    /// A task or workflow run.
    TaskId, "task"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_typed() {
        let a = ProcessId::next();
        let b = ProcessId::next();
        assert_ne!(a, b);
        assert!(b.raw() > a.raw());
        assert!(a.to_string().starts_with("proc"));
        assert!(WorkspaceId::next().to_string().starts_with("ws"));
    }
}
