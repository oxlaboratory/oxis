//! Structured logging (`tracing`). OXIS logs to stderr and, when given a
//! folder, to `oxis.log` there. `OXIS_LOG` sets the filter (for example
//! `OXIS_LOG=oxide=debug`); the default is `info`. Never log secrets:
//! log what happened and to which thing, not tokens, passwords or input
//! typed at a password prompt.

use std::fs::OpenOptions;
use std::path::Path;
use std::sync::Mutex;

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Sets up logging once; later calls do nothing.
pub fn init(log_dir: Option<&Path>) {
    let filter = EnvFilter::try_from_env("OXIS_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let stderr = fmt::layer().with_writer(std::io::stderr).with_target(false);
    let file = log_dir.and_then(|dir| {
        std::fs::create_dir_all(dir).ok()?;
        let f = OpenOptions::new().create(true).append(true).open(dir.join("oxis.log")).ok()?;
        Some(fmt::layer().with_ansi(false).with_writer(Mutex::new(f)))
    });
    let _ = tracing_subscriber::registry().with(filter).with(stderr).with(file).try_init();
}
