//! What the engine reads from Git. Git is an external tool: OXIS uses the
//! one on `PATH` if there is one and never installs it. Without Git these
//! simply return nothing.

use std::path::Path;
use std::process::{Command, Stdio};

/// The URL of a folder's `origin` remote, or of its first remote if it has
/// no `origin`. `None` if the folder isn't a Git repository, has no
/// remotes, or Git isn't installed.
pub fn remote_url(folder: &Path) -> Option<String> {
    if let Some(url) = git(folder, &["remote", "get-url", "origin"]) {
        return Some(url);
    }
    let first = git(folder, &["remote"])?.lines().next()?.trim().to_owned();
    git(folder, &["remote", "get-url", &first])
}

/// Runs `git -C <folder> <args>` and returns its trimmed output if it
/// succeeded and printed something.
fn git(folder: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(folder).args(args).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !text.is_empty()).then_some(text)
}
