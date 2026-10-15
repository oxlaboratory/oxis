//! The engine as one object: the event bus, settings, workspaces and
//! processes, wired so that their rules hold together — closing a
//! workspace stops the processes it owns, and a workspace's environment
//! and folder apply to what it starts.

use std::path::{Path, PathBuf};

use crate::config::{self, Settings};
use crate::error::Result;
use crate::events::EventBus;
use crate::ids::{ProcessId, WorkspaceId};
use crate::process::{ProcessEngine, ProcessSpec};
use crate::workspace::WorkspaceEngine;

pub struct Engine {
    pub bus: EventBus,
    pub settings: Settings,
    pub workspaces: WorkspaceEngine,
    pub processes: ProcessEngine,
    data_dir: PathBuf,
}

impl Engine {
    /// Opens the engine over a data folder: `settings.json`, `workspaces/`
    /// and `logs/` live there. A corrupt settings file is set aside and the
    /// defaults used.
    pub fn open(data_dir: impl Into<PathBuf>) -> Result<Self> {
        let data_dir = data_dir.into();
        let bus = EventBus::new();
        let loaded = config::load::<Settings>(&data_dir.join("settings.json"))?;
        if let Some(aside) = &loaded.recovered_from {
            tracing::warn!("settings.json couldn't be read; kept it as {} and started from the defaults", aside.display());
        }
        Ok(Self {
            workspaces: WorkspaceEngine::new(data_dir.join("workspaces"), bus.clone()),
            processes: ProcessEngine::new(bus.clone()),
            settings: loaded.value,
            bus,
            data_dir,
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn save_settings(&self) -> Result<()> {
        config::save(&self.data_dir.join("settings.json"), &self.settings)
    }

    /// Starts a process for a workspace: in its folder unless the spec says
    /// otherwise, with its environment added, owned by it.
    pub fn spawn_in(&self, ws: WorkspaceId, mut spec: ProcessSpec) -> Result<ProcessId> {
        let w = self.workspaces.get(ws).ok_or(crate::Error::NoWorkspace(ws))?;
        if spec.cwd.is_none() {
            spec.cwd = w.data.folder.clone();
        }
        let mut env: Vec<(String, String)> = w.data.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        env.extend(spec.env.drain(..));
        spec.env = env;
        spec.owner = Some(ws);
        self.processes.spawn(spec)
    }

    /// Closes a workspace: stops the processes it owns, then saves and
    /// closes it.
    pub fn close_workspace(&mut self, ws: WorkspaceId) -> Result<usize> {
        let stopped = self.processes.cancel_owned_by(ws);
        self.workspaces.close(ws)?;
        Ok(stopped)
    }
}
