//! The shells installed on this machine. OXIS uses what's there and never
//! installs one.

use std::path::{Path, PathBuf};

/// A shell OXIS can run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shell {
    /// What the user picks it by: `powershell`, `pwsh`, `cmd`, `bash`,
    /// `zsh`, `fish`, `sh`, … or a path.
    pub name: String,
    pub program: PathBuf,
    /// Arguments for an interactive session in a terminal.
    pub interactive: Vec<String>,
    /// Arguments before a command line, to run one command and exit.
    pub command: Vec<String>,
}

impl Shell {
    fn new(name: &str, program: PathBuf) -> Self {
        let kind = kind_of(name, &program);
        let (interactive, command): (&[&str], &[&str]) = match kind.as_str() {
            "powershell" | "pwsh" => (&["-NoLogo"], &["-NoLogo", "-NonInteractive", "-Command"]),
            "cmd" => (&[], &["/D", "/S", "/C"]),
            // Git Bash on Windows needs a login shell to set up its PATH.
            "bash" if cfg!(windows) => (&["--login", "-i"], &["-c"]),
            "nu" => (&[], &["-c"]),
            _ => (&[], &["-c"]),
        };
        Self {
            name: name.to_owned(),
            program,
            interactive: interactive.iter().map(|s| s.to_string()).collect(),
            command: command.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// `C:\…\pwsh.exe` → `pwsh`.
fn kind_of(name: &str, program: &Path) -> String {
    let stem = program.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    stem.to_ascii_lowercase()
}

/// The shell `choice` names (a setting: `auto`, a shell's name, or a
/// path), if it's installed.
///
/// `auto` is PowerShell 7 if installed, else Windows PowerShell, on
/// Windows; elsewhere it's `$SHELL`, falling back to `/bin/sh`.
pub fn resolve(choice: &str) -> Option<Shell> {
    let choice = choice.trim();
    if choice.is_empty() || choice == "auto" {
        return default_shell();
    }
    let as_path = Path::new(choice);
    if as_path.components().count() > 1 || as_path.is_absolute() {
        return as_path.is_file().then(|| Shell::new(&kind_of(choice, as_path), as_path.to_owned()));
    }
    if cfg!(windows) && choice == "bash" {
        if let Some(git_bash) = git_bash() {
            return Some(Shell::new("bash", git_bash));
        }
    }
    find_on_path(choice).map(|p| Shell::new(choice, p))
}

fn default_shell() -> Option<Shell> {
    if cfg!(windows) {
        return resolve("pwsh").or_else(|| resolve("powershell")).or_else(|| resolve("cmd"));
    }
    if let Ok(sh) = std::env::var("SHELL") {
        let path = PathBuf::from(&sh);
        if path.is_file() {
            return Some(Shell::new(&kind_of(&sh, &path), path));
        }
    }
    resolve("/bin/sh")
}

/// The shells installed here, the default first.
pub fn available() -> Vec<Shell> {
    let names: &[&str] = if cfg!(windows) { &["pwsh", "powershell", "cmd", "bash", "nu"] } else { &["bash", "zsh", "fish", "sh", "nu", "dash", "ksh"] };
    let mut found: Vec<Shell> = Vec::new();
    for shell in default_shell().into_iter().chain(names.iter().filter_map(|n| resolve(n))) {
        if !found.iter().any(|s| s.program == shell.program) {
            found.push(shell);
        }
    }
    found
}

/// Git for Windows' bash, which isn't usually on `PATH` (and `bash.exe` in
/// System32 is WSL's, a different thing).
#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA"];
    roots
        .iter()
        .filter_map(std::env::var_os)
        .flat_map(|r| {
            let r = PathBuf::from(r);
            [r.join("Git").join("bin").join("bash.exe"), r.join("Programs").join("Git").join("bin").join("bash.exe")]
        })
        .find(|p| p.is_file())
}

#[cfg(not(windows))]
fn git_bash() -> Option<PathBuf> {
    None
}

/// A program on `PATH` (with Windows' executable extensions).
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into()).split(';').map(|e| e.to_ascii_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() && is_runnable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_runnable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_runnable(_: &Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_finds_a_shell() {
        let sh = resolve("auto").expect("a default shell");
        assert!(sh.program.is_file(), "{sh:?}");
        assert!(!sh.command.is_empty());
        assert_eq!(available().first(), Some(&sh));
    }

    #[test]
    fn a_missing_shell_is_none() {
        assert_eq!(resolve("definitely-not-a-shell-xyz"), None);
        assert_eq!(resolve("/nonexistent/sh"), None);
    }

    #[test]
    fn arguments_suit_the_shell() {
        let ps = Shell::new("powershell", PathBuf::from("C:/x/powershell.exe"));
        assert_eq!(ps.command.last().unwrap(), "-Command");
        let cmd = Shell::new("cmd", PathBuf::from("C:/x/cmd.exe"));
        assert_eq!(cmd.command, ["/D", "/S", "/C"]);
        let zsh = Shell::new("zsh", PathBuf::from("/bin/zsh"));
        assert_eq!(zsh.command, ["-c"]);
    }
}
