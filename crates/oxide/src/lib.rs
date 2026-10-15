//! The OXIDE Engine — the engine under OXIS.
//!
//! Everything OXIS does that isn't drawing lives here: configuration and
//! persistence, the event bus, workspaces, processes, and (as later phases
//! land) projects, tasks and workflows. It has no idea what draws it — the
//! interface subscribes to [`events`] and calls the engines' methods.
//!
//! See `docs/v2/README.md` for the architecture and the migration plan.

pub mod config;
mod engine;
pub mod error;
pub mod events;
pub mod git;
pub mod ids;
pub mod logging;
pub mod process;
pub mod terminal;
pub mod workspace;

pub use engine::Engine;
pub use error::{Error, Result};

/// The version this engine was built as (the workspace's Cargo version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
