//! Durable, versioned JSON documents: settings, workspaces, layouts.
//!
//! A document is stored as `{"format": N, "data": {...}}`.
//! - Saving writes a temporary file beside the target, flushes it to disk
//!   and renames it over the target, so a crash mid-write never leaves a
//!   half-written file.
//! - Loading a missing file gives the defaults.
//! - A file that doesn't parse is moved aside (`<name>.corrupt-<n>`) and
//!   replaced by the defaults; the caller is told so it can say so.
//! - An older format is migrated step by step ([`Document::migrate`]).
//! - A newer format is refused, and the file left alone, rather than
//!   silently thrown away by an older build.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// A type that can be stored as a versioned document.
pub trait Document: Serialize + DeserializeOwned + Default {
    /// The current format number. Bump it when the stored shape changes,
    /// and teach [`migrate`](Document::migrate) the step from the old one.
    const FORMAT: u32;

    /// Turns `data` stored as format `from` into format `from + 1`.
    fn migrate(from: u32, data: serde_json::Value) -> std::result::Result<serde_json::Value, String> {
        let _ = from;
        Ok(data)
    }
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: u32,
    data: serde_json::Value,
}

/// What [`load`] found.
#[derive(Debug)]
pub struct Loaded<T> {
    pub value: T,
    /// Where an unreadable file was moved to before the defaults were used.
    pub recovered_from: Option<PathBuf>,
    /// True when the file didn't exist yet.
    pub fresh: bool,
}

pub fn load<T: Document>(path: &Path) -> Result<Loaded<T>> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded { value: T::default(), recovered_from: None, fresh: true })
        }
        Err(e) => return Err(Error::io("couldn't read", path, e)),
    };

    enum Problem {
        TooNew(u32),
        Unreadable(String),
    }
    let parsed = (|| {
        let env: Envelope = serde_json::from_str(&text).map_err(|e| Problem::Unreadable(e.to_string()))?;
        if env.format > T::FORMAT {
            return Err(Problem::TooNew(env.format));
        }
        let mut data = env.data;
        for from in env.format..T::FORMAT {
            data = T::migrate(from, data).map_err(Problem::Unreadable)?;
        }
        serde_json::from_value::<T>(data).map_err(|e| Problem::Unreadable(e.to_string()))
    })();

    match parsed {
        Ok(value) => Ok(Loaded { value, recovered_from: None, fresh: false }),
        Err(Problem::TooNew(found)) => Err(Error::ConfigTooNew { path: path.to_owned(), found, supported: T::FORMAT }),
        Err(Problem::Unreadable(msg)) => {
            let aside = quarantine(path)?;
            tracing::warn!(path = %path.display(), moved_to = %aside.display(), "unreadable config replaced by defaults: {msg}");
            Ok(Loaded { value: T::default(), recovered_from: Some(aside), fresh: false })
        }
    }
}

pub fn save<T: Document>(path: &Path, value: &T) -> Result<()> {
    let env = Envelope {
        format: T::FORMAT,
        data: serde_json::to_value(value).map_err(|e| Error::Config { path: path.to_owned(), message: e.to_string() })?,
    };
    let text = serde_json::to_string_pretty(&env).expect("a JSON value always serialises");
    write_atomic(path, text.as_bytes())
}

/// Writes `bytes` to `path` so that readers see either the old file or the
/// new one, never a mix.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir).map_err(|e| Error::io("couldn't create", dir, e))?;
        }
    }
    let tmp = sibling(path, &format!("tmp-{}", std::process::id()));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| Error::io("couldn't write", &tmp, e))?;
        f.write_all(bytes).map_err(|e| Error::io("couldn't write", &tmp, e))?;
        f.sync_all().map_err(|e| Error::io("couldn't flush", &tmp, e))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        Error::io("couldn't replace", path, e)
    })
}

/// Moves an unreadable file to the first free `<name>.corrupt-<n>`.
fn quarantine(path: &Path) -> Result<PathBuf> {
    for n in 1.. {
        let aside = sibling(path, &format!("corrupt-{n}"));
        if !aside.exists() {
            fs::rename(path, &aside).map_err(|e| Error::io("couldn't move aside", path, e))?;
            return Ok(aside);
        }
    }
    unreachable!()
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".{suffix}"));
    path.with_file_name(name)
}

/// The application's own settings (`settings.json`). New fields need
/// `#[serde(default)]` so older files keep loading.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// The shell new terminals start: `auto` or a shell's name.
    pub shell: String,
    pub theme: String,
    pub font_size: f32,
    /// Bring back the last session's workspaces and tabs at startup.
    pub restore_session: bool,
    /// The workspace that was active when OXIS last closed.
    pub last_workspace: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shell: "auto".into(),
            theme: "default".into(),
            font_size: 14.0,
            restore_session: true,
            last_workspace: None,
        }
    }
}

impl Document for Settings {
    const FORMAT: u32 = 1;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct V2 {
        name: String,
        size: u32,
    }
    impl Document for V2 {
        const FORMAT: u32 = 2;
        fn migrate(from: u32, mut data: serde_json::Value) -> std::result::Result<serde_json::Value, String> {
            assert_eq!(from, 1);
            // format 1 called it "title"
            let title = data["title"].take();
            Ok(serde_json::json!({ "name": title, "size": 1 }))
        }
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let got = load::<Settings>(&dir.path().join("settings.json")).unwrap();
        assert!(got.fresh);
        assert_eq!(got.value, Settings::default());
    }

    #[test]
    fn round_trips_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/settings.json");
        let s = Settings { theme: "ember".into(), font_size: 16.0, ..Settings::default() };
        save(&path, &s).unwrap();
        save(&path, &s).unwrap(); // replacing an existing file works too
        assert_eq!(load::<Settings>(&path).unwrap().value, s);
        let names: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("settings.json")]);
    }

    #[test]
    fn corrupt_file_is_kept_aside_and_defaults_used() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ this is not json").unwrap();
        let got = load::<Settings>(&path).unwrap();
        assert_eq!(got.value, Settings::default());
        let aside = got.recovered_from.expect("moved aside");
        assert_eq!(fs::read_to_string(aside).unwrap(), "{ this is not json");
        assert!(!path.exists());
    }

    #[test]
    fn older_formats_are_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        fs::write(&path, r#"{"format":1,"data":{"title":"acme"}}"#).unwrap();
        assert_eq!(load::<V2>(&path).unwrap().value, V2 { name: "acme".into(), size: 1 });
    }

    #[test]
    fn newer_formats_are_refused_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        let text = r#"{"format":9,"data":{}}"#;
        fs::write(&path, text).unwrap();
        match load::<V2>(&path) {
            Err(Error::ConfigTooNew { found: 9, supported: 2, .. }) => {}
            other => panic!("expected ConfigTooNew, got {other:?}"),
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn unknown_fields_and_missing_fields_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"format":1,"data":{"theme":"paper","future":true}}"#).unwrap();
        let s = load::<Settings>(&path).unwrap().value;
        assert_eq!(s.theme, "paper");
        assert_eq!(s.font_size, Settings::default().font_size);
    }
}
