//! End-to-end tests of the OXIS window: the real binary, a hidden window,
//! and real input driven through the interface (see `src/drive.rs`).
//!
//! They need a display. On Linux without one (no `DISPLAY` or
//! `WAYLAND_DISPLAY`) they're skipped; CI runs them under Xvfb.

use std::path::Path;
use std::process::Command;

use serde_json::Value;

fn has_display() -> bool {
    cfg!(windows) || cfg!(target_os = "macos") || std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Runs a script against a fresh data folder; returns the exit code.
fn drive(data: &Path, script: &str, size: &str) -> i32 {
    let file = data.join("script.txt");
    std::fs::create_dir_all(data).unwrap();
    std::fs::write(&file, script).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_oxis"))
        .arg("--drive")
        .arg(&file)
        .arg(size)
        .env("OXIS_DATA", data)
        .env("OXIS_LOG", "warn")
        .current_dir(data)
        .output()
        .expect("couldn't start oxis");
    if !out.status.success() {
        eprintln!("stdout:\n{}\nstderr:\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
    out.status.code().unwrap_or(-1)
}

fn read(data: &Path, name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(data.join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))).unwrap()
}

/// Commands in the platform's default shell.
struct Cmds {
    hello: &'static str,
    fail3: &'static str,
    missing: &'static str,
    long: &'static str,
    show_env: &'static str,
}

const CMDS: Cmds = if cfg!(windows) {
    Cmds {
        hello: "Write-Output hello; Write-Output world",
        fail3: "[Console]::Error.WriteLine('oops'); exit 3",
        missing: "definitely-not-a-program-xyz",
        long: "Write-Output started; Start-Sleep 60",
        show_env: "Write-Output \"pwd=$((Get-Location).Path) port=$env:PORT only=$env:ONLY_A\"",
    }
} else {
    Cmds {
        hello: "echo hello; echo world",
        fail3: "echo oops >&2; exit 3",
        missing: "definitely-not-a-program-xyz",
        long: "echo started; sleep 60",
        show_env: "echo \"pwd=$(pwd -P) port=$PORT only=$ONLY_A\"",
    }
};

#[test]
fn commands_run_through_the_run_view() {
    if !has_display() {
        eprintln!("no display; skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    let script = format!(
        "frames 3\nclick nav:run\nframes 3\n\
         type {hello}\nkey Enter\nwait-idle 20000\n\
         type {fail3}\nkey Enter\nwait-idle 20000\n\
         type {missing}\nkey Enter\nwait-idle 20000\n\
         type {long}\nkey Enter\nwait-for started\nclick stop:3\nwait-idle 10000\n\
         type {long}\nkey Enter\nwait-for started\nkey Ctrl+C\nwait-idle 10000\n\
         frames 2\ndump state.json\n",
        hello = CMDS.hello,
        fail3 = CMDS.fail3,
        missing = CMDS.missing,
        long = CMDS.long,
    );
    assert_eq!(drive(data, &script, "1000x640"), 0);
    let state = read(data, "state.json");
    let runs = state["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 5, "{state:#}");

    assert_eq!(runs[0]["code"], 0);
    assert_eq!(runs[0]["stdout"], serde_json::json!(["hello", "world"]));

    assert_eq!(runs[1]["code"], 3);
    assert_eq!(runs[1]["cancelled"], false);
    assert_eq!(runs[1]["stderr"][0], "oops");

    assert_ne!(runs[2]["code"], 0, "a missing program fails");
    assert!(runs[2]["stderr"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("definitely-not-a-program-xyz")));

    for (i, how) in [(3, "Stop"), (4, "Ctrl+C")] {
        assert_eq!(runs[i]["cancelled"], true, "{how} stops the command: {state:#}");
        assert_eq!(runs[i]["status"], "exited");
        assert_eq!(runs[i]["stdout"][0], "started");
    }
    assert_eq!(state["notice"], Value::Null, "nothing went wrong");
}

#[test]
fn a_shell_that_isnt_installed_is_reported() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    // A shell this machine doesn't have.
    let shell = if cfg!(windows) { "pwsh" } else { "/nonexistent/sh" };
    if cfg!(windows) && Command::new("pwsh").arg("-v").output().is_ok() {
        eprintln!("pwsh is installed; skipping");
        return;
    }
    std::fs::write(data.join("settings.json"), format!("{{\"format\":1,\"data\":{{\"shell\":\"{shell}\"}}}}")).unwrap();
    assert_eq!(drive(data, "frames 3\nclick nav:run\nframes 3\ntype echo hi\nkey Enter\nframes 3\ndump state.json\n", "1000x640"), 0);
    let state = read(data, "state.json");
    assert_eq!(state["runs"].as_array().unwrap().len(), 0);
    assert_eq!(state["notice"]["error"], true);
    assert!(state["notice"]["text"].as_str().unwrap().contains("couldn't start"), "{state:#}");
}

#[test]
fn workspaces_stay_separate_through_the_interface() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let (pa, pb) = (dir.path().join("proj-a"), dir.path().join("proj-b"));
    std::fs::create_dir_all(&pa).unwrap();
    std::fs::create_dir_all(&pb).unwrap();
    let git = |d: &Path, args: &[&str]| Command::new("git").arg("-C").arg(d).args(args).output().is_ok_and(|o| o.status.success());
    let have_git = git(&pa, &["init", "-q"]) && git(&pb, &["init", "-q"]);
    if have_git {
        assert!(git(&pa, &["remote", "add", "origin", "https://example.com/a.git"]));
        assert!(git(&pb, &["remote", "add", "origin", "https://example.com/b.git"]));
    }
    let script = format!(
        "frames 3\n\
         click new-ws\ntype a\nkey Enter\nframes 3\n\
         click link\ntype {pa}\nkey Enter\nframes 3\n\
         click env\ntype PORT=3000\nkey Enter\nframes 3\n\
         click env\ntype ONLY_A=yes\nkey Enter\nframes 3\n\
         click new-ws\ntype b\nkey Enter\nframes 3\n\
         click link\ntype {pb}\nkey Enter\nframes 3\n\
         click env\ntype PORT=4000\nkey Enter\nframes 3\n\
         click ws:a\nframes 3\n\
         click nav:run\nframes 3\ntype {show}\nkey Enter\nwait-idle 20000\ntype {long}\nkey Enter\nwait-for started\n\
         click nav:home\nframes 3\nclick ws:b\nframes 3\n\
         click nav:run\nframes 3\ntype {show}\nkey Enter\nwait-idle 20000\nkey Ctrl+C\nframes 3\n\
         dump in-b.json\n\
         click nav:home\nframes 3\nclick ws:a\nframes 3\nclick nav:run\nframes 3\nkey Ctrl+C\nwait-idle 10000\nframes 2\n\
         dump in-a.json\n",
        pa = pa.display(),
        pb = pb.display(),
        show = CMDS.show_env,
        long = CMDS.long,
    );
    assert_eq!(drive(&data, &script, "1100x700"), 0);

    let canon = |p: &Path| {
        let c = p.canonicalize().unwrap().display().to_string();
        c.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(c)
    };
    let in_b = read(&data, "in-b.json");
    let in_a = read(&data, "in-a.json");
    let ws = |s: &Value, name: &str| s["open"].as_array().unwrap().iter().find(|w| w["name"] == name).cloned().unwrap();

    // Each workspace kept its own folder, remote and environment.
    for s in [&in_b, &in_a] {
        let (a, b) = (ws(s, "a"), ws(s, "b"));
        assert_eq!(a["folder"], canon(&pa));
        assert_eq!(b["folder"], canon(&pb));
        assert_eq!(a["env"], serde_json::json!({ "PORT": "3000", "ONLY_A": "yes" }));
        assert_eq!(b["env"], serde_json::json!({ "PORT": "4000" }));
        if have_git {
            assert_eq!(a["git_remote"], "https://example.com/a.git");
            assert_eq!(b["git_remote"], "https://example.com/b.git");
        }
    }

    // In b: a's commands aren't shown, a's long command is still running
    // (b's Ctrl+C didn't touch it), and b's command saw only b's settings.
    assert_eq!(in_b["active"]["name"], "b");
    let runs = in_b["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 3, "{in_b:#}");
    let line = |r: &Value| r["stdout"][0].as_str().unwrap().to_owned();
    assert!(runs[0]["workspace"] == "a" && runs[0]["visible"] == false);
    assert_eq!(line(&runs[0]), format!("pwd={} port=3000 only=yes", canon(&pa)));
    assert!(runs[1]["workspace"] == "a" && runs[1]["status"] == "running", "{in_b:#}");
    assert!(runs[2]["workspace"] == "b" && runs[2]["visible"] == true);
    assert_eq!(line(&runs[2]), format!("pwd={} port=4000 only=", canon(&pb)));

    // Back in a, Ctrl+C stopped a's command.
    assert_eq!(in_a["active"]["name"], "a");
    assert_eq!(in_a["runs"][1]["cancelled"], true);

    // On disk: one file each, and the last workspace remembered.
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["data"]["last_workspace"], "a");
    let b_file: Value = serde_json::from_str(&std::fs::read_to_string(data.join("workspaces/b/workspace.json")).unwrap()).unwrap();
    assert_eq!(b_file["data"]["env"], serde_json::json!({ "PORT": "4000" }));
}

#[test]
fn the_window_works_at_small_and_large_sizes() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    // The minimum size, a small laptop, and a resize while running.
    let script = "frames 3\nsnapshot home-min.png\nclick nav:run\nframes 2\nsnapshot run-min.png\nclick nav:settings\nframes 2\n\
                  resize 1366x768\nframes 3\nclick nav:home\nframes 2\nsnapshot home-laptop.png\ndump state.json\n";
    assert_eq!(drive(data, script, "720x460"), 0);
    // Kept under target/tmp so CI can attach them: how each OS renders.
    let keep = Path::new(env!("CARGO_TARGET_TMPDIR")).join("drive-artifacts");
    std::fs::create_dir_all(&keep).unwrap();
    for f in ["home-min.png", "run-min.png", "home-laptop.png"] {
        assert!(colours(&data.join(f)) > 16, "{f} is blank: nothing was drawn");
        std::fs::copy(data.join(f), keep.join(f)).unwrap();
    }
    assert_eq!(read(data, "state.json")["view"], "home");
}

/// How many different colours a PNG has (a blank frame has one or two).
fn colours(path: &Path) -> usize {
    let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).unwrap();
    let px = info.color_type.samples();
    buf[..info.buffer_size()].chunks(px).map(|c| c.to_vec()).collect::<std::collections::HashSet<_>>().len()
}

#[test]
fn a_script_that_cant_be_followed_fails() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(drive(dir.path(), "frames 2\nclick no-such-control\n", "800x500"), 2);
}
