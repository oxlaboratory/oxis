//! Workspaces: one per project, each with its own folder link, Git remote,
//! environment and settings.
//!
//! A workspace lives on disk as `<root>/<name>/workspace.json`. Every
//! workspace has its own file, written atomically, so changing one can
//! never overwrite another — switching workspaces only changes which one is
//! active. What happens to a workspace's processes and terminals when it
//! closes is decided by the [`Engine`](crate::Engine) that owns both
//! engines: they're stopped.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::{self, Document};
use crate::error::{Error, Result};
use crate::events::{Event, EventBus};
use crate::ids::WorkspaceId;

const FILE: &str = "workspace.json";

/// What a workspace remembers.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceData {
    /// The project folder this workspace works in, if it's linked to one.
    pub folder: Option<PathBuf>,
    /// The Git remote this workspace pushes to (e.g. `github:owner/repo`).
    /// Kept per workspace so two projects never share a remote by accident.
    pub git_remote: Option<String>,
    /// Environment variables added for this workspace's processes.
    pub env: BTreeMap<String, String>,
    /// Workspace-specific settings, overriding the application's.
    pub settings: BTreeMap<String, serde_json::Value>,
}

impl Document for WorkspaceData {
    const FORMAT: u32 = 1;
}

#[derive(Clone, Debug)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
    pub data: WorkspaceData,
}

pub struct WorkspaceEngine {
    root: PathBuf,
    bus: EventBus,
    open: HashMap<WorkspaceId, Workspace>,
    active: Option<WorkspaceId>,
}

impl WorkspaceEngine {
    /// Workspaces are kept under `root` (created when the first one is).
    pub fn new(root: impl Into<PathBuf>, bus: EventBus) -> Self {
        Self { root: root.into(), bus, open: HashMap::new(), active: None }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The names of the workspaces on disk, sorted.
    pub fn list(&self) -> Result<Vec<String>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Error::io("couldn't list", &self.root, e)),
        };
        let mut names: Vec<String> =
            entries.filter_map(|e| e.ok()).filter(|e| e.path().join(FILE).is_file()).filter_map(|e| e.file_name().into_string().ok()).collect();
        names.sort();
        Ok(names)
    }

    /// Makes a new workspace and opens it.
    pub fn create(&mut self, name: &str, data: WorkspaceData) -> Result<WorkspaceId> {
        validate_name(name)?;
        let dir = self.root.join(name);
        if dir.join(FILE).exists() {
            return Err(Error::WorkspaceExists(name.to_owned()));
        }
        config::save(&dir.join(FILE), &data)?;
        let id = WorkspaceId::next();
        self.open.insert(id, Workspace { id, name: name.to_owned(), data });
        self.bus.publish(Event::WorkspaceCreated { id, name: name.to_owned() });
        self.bus.publish(Event::WorkspaceOpened { id, name: name.to_owned() });
        Ok(id)
    }

    /// Opens a workspace from disk (or returns it if it's already open).
    pub fn open(&mut self, name: &str) -> Result<WorkspaceId> {
        if let Some(w) = self.open.values().find(|w| w.name == name) {
            return Ok(w.id);
        }
        validate_name(name)?;
        let path = self.root.join(name).join(FILE);
        if !path.exists() {
            return Err(Error::io("couldn't open", &path, std::io::ErrorKind::NotFound.into()));
        }
        let loaded = config::load::<WorkspaceData>(&path)?;
        let id = WorkspaceId::next();
        self.open.insert(id, Workspace { id, name: name.to_owned(), data: loaded.value });
        self.bus.publish(Event::WorkspaceOpened { id, name: name.to_owned() });
        Ok(id)
    }

    /// Saves and closes a workspace. If it was active, none is.
    pub fn close(&mut self, id: WorkspaceId) -> Result<()> {
        let ws = self.open.get(&id).ok_or(Error::NoWorkspace(id))?;
        config::save(&self.root.join(&ws.name).join(FILE), &ws.data)?;
        let ws = self.open.remove(&id).expect("checked above");
        if self.active == Some(id) {
            self.active = None;
            self.bus.publish(Event::WorkspaceActivated { id: None });
        }
        self.bus.publish(Event::WorkspaceClosed { id, name: ws.name });
        Ok(())
    }

    pub fn rename(&mut self, id: WorkspaceId, to: &str) -> Result<()> {
        validate_name(to)?;
        let from = self.open.get(&id).ok_or(Error::NoWorkspace(id))?.name.clone();
        if from == to {
            return Ok(());
        }
        let (old_dir, new_dir) = (self.root.join(&from), self.root.join(to));
        if new_dir.exists() {
            return Err(Error::WorkspaceExists(to.to_owned()));
        }
        fs::rename(&old_dir, &new_dir).map_err(|e| Error::io("couldn't rename", &old_dir, e))?;
        self.open.get_mut(&id).expect("checked above").name = to.to_owned();
        self.bus.publish(Event::WorkspaceRenamed { id, from, to: to.to_owned() });
        Ok(())
    }

    /// Makes an open workspace the active one.
    pub fn activate(&mut self, id: WorkspaceId) -> Result<()> {
        if !self.open.contains_key(&id) {
            return Err(Error::NoWorkspace(id));
        }
        if self.active != Some(id) {
            self.active = Some(id);
            self.bus.publish(Event::WorkspaceActivated { id: Some(id) });
        }
        Ok(())
    }

    pub fn active(&self) -> Option<&Workspace> {
        self.active.and_then(|id| self.open.get(&id))
    }

    pub fn get(&self, id: WorkspaceId) -> Option<&Workspace> {
        self.open.get(&id)
    }

    pub fn open_workspaces(&self) -> impl Iterator<Item = &Workspace> {
        self.open.values()
    }

    /// Changes one workspace's data and saves it. Only that workspace's file
    /// is written.
    /// Changes a workspace and saves it. If saving fails, the workspace is
    /// left as it was, so what's in memory never drifts from what's on disk.
    pub fn update(&mut self, id: WorkspaceId, change: impl FnOnce(&mut WorkspaceData)) -> Result<()> {
        let ws = self.open.get_mut(&id).ok_or(Error::NoWorkspace(id))?;
        let mut data = ws.data.clone();
        change(&mut data);
        config::save(&self.root.join(&ws.name).join(FILE), &data)?;
        ws.data = data;
        Ok(())
    }
}

/// `KEY=value` → (`KEY`, `value`), for typing a variable in one line.
pub fn parse_env_assignment(line: &str) -> Result<(String, String)> {
    let (key, value) = line.split_once('=').ok_or_else(|| Error::BadEnvVar(line.trim().to_owned(), "write it as NAME=value"))?;
    let key = key.trim();
    validate_env_key(key)?;
    Ok((key.to_owned(), value.trim().to_owned()))
}

/// An environment variable name: non-empty, no `=`, no spaces or control
/// characters.
pub fn validate_env_key(key: &str) -> Result<()> {
    let bad = |why| Err(Error::BadEnvVar(key.to_owned(), why));
    if key.is_empty() {
        return bad("the name is empty");
    }
    if key.contains('=') {
        return bad("the name can't contain =");
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return bad("the name can't contain spaces");
    }
    Ok(())
}

/// A workspace name is a folder name: non-empty, at most 64 characters, no
/// path separators or characters Windows forbids, and not `.` or `..`.
pub fn validate_name(name: &str) -> Result<()> {
    let bad = |why| Err(Error::BadWorkspaceName(name.to_owned(), why));
    if name.trim().is_empty() {
        return bad("it's empty");
    }
    if name.chars().count() > 64 {
        return bad("it's longer than 64 characters");
    }
    if name == "." || name == ".." {
        return bad("it's a special folder name");
    }
    if name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()) {
        return bad("it contains / \\ : * ? \" < > | or a control character");
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return bad("it ends with a space or a dot");
    }
    Ok(())
}
