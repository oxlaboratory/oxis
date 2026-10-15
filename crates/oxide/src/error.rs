//! The engine's error type. Errors say what failed and on what, in words a
//! user can act on; the interface shows them as they are.

use std::path::PathBuf;

use crate::ids::{ProcessId, WorkspaceId};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{action} {path}: {source}")]
    Io {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("{path} isn't valid: {message}")]
    Config { path: PathBuf, message: String },

    #[error("{path} was written by a newer OXIS (format {found}, this build reads up to {supported})")]
    ConfigTooNew { path: PathBuf, found: u32, supported: u32 },

    #[error("there's no workspace {0}")]
    NoWorkspace(WorkspaceId),

    #[error("a workspace named \"{0}\" already exists")]
    WorkspaceExists(String),

    #[error("\"{0}\" can't be used as a workspace name: {1}")]
    BadWorkspaceName(String, &'static str),

    #[error("couldn't start {program}: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },

    #[error("there's no process {0}")]
    NoProcess(ProcessId),
}

impl Error {
    pub(crate) fn io(action: &'static str, path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Error::Io { action, path: path.into(), source }
    }
}
