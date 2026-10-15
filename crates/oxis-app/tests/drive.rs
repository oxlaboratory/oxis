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
    assert!(state["notice"]["text"].as_str().unwrap().contains("isn't installed"), "{state:#}");
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

// ── the Terminal view ───────────────────────────────────────────────────

/// Terminal tests pin the shell (cmd on Windows, sh elsewhere) so what it
/// prints is predictable.
fn pin_shell(data: &Path) {
    std::fs::create_dir_all(data).unwrap();
    let shell = if cfg!(windows) { "cmd" } else { "sh" };
    std::fs::write(data.join("settings.json"), format!("{{\"format\":1,\"data\":{{\"shell\":\"{shell}\"}}}}")).unwrap();
}

struct Term {
    prompt: &'static str,
    calc42: &'static str,
    calc333: &'static str,
    long: &'static str,
    who: &'static str,
    pwd: &'static str,
}

const TERM: Term = if cfg!(windows) {
    Term { prompt: ">", calc42: "set /a 40+2", calc333: "set /a 300+33", long: "ping -n 30 127.0.0.1", who: "echo %WHO%", pwd: "cd" }
} else {
    Term { prompt: "$", calc42: "echo $((40+2))", calc333: "echo $((300+33))", long: "sleep 30", who: "echo $WHO", pwd: "pwd -P" }
};

fn panes(state: &Value) -> Vec<Value> {
    state["terminal"]["tabs"].as_array().unwrap().iter().flat_map(|t| t["panes"].as_array().unwrap().clone()).collect()
}

#[test]
fn the_terminal_runs_a_real_shell_with_tabs_and_splits() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    pin_shell(data);
    let t = TERM;
    let script = format!(
        "frames 3\nclick nav:terminal\nframes 5\nwait-screen {prompt}\n\
         type {calc42}\nkey Enter\nwait-screen 42\n\
         type {long}\nkey Enter\nwait 1500\nkey Ctrl+C\nframes 3\n\
         type {calc333}\nkey Enter\nwait-screen 333\n\
         dump one.json\n\
         click term-split-right\nframes 5\nwait-screen {prompt}\ndump split.json\n\
         key Ctrl+Shift+W\nframes 5\ndump closed.json\n\
         key Ctrl+Shift+T\nframes 5\nwait-screen {prompt}\ndump tabs.json\n\
         click term-tab-close:1\nframes 5\n\
         type exit 5\nkey Enter\nwait 3000\nframes 3\ndump exited.json\n\
         key Enter\nframes 5\ndump none.json\n\
         click term-open\nframes 5\nwait-screen {prompt}\ndump reopened.json\n",
        prompt = t.prompt,
        calc42 = t.calc42,
        calc333 = t.calc333,
        long = t.long,
    );
    assert_eq!(drive(data, &script, "1200x720"), 0);

    // One real shell: output, and Ctrl+C stopped the long command (the
    // next one ran right away in the same shell).
    let one = read(data, "one.json");
    assert_eq!(one["view"], "terminal");
    let p = panes(&one);
    assert_eq!(p.len(), 1, "{one:#}");
    let text = p[0]["text"].as_str().unwrap();
    assert!(text.lines().any(|l| l.trim() == "42"), "{text}");
    assert!(text.lines().any(|l| l.trim() == "333"), "{text}");
    assert!(p[0]["exited"].is_null());
    let full_cols = p[0]["cols"].as_u64().unwrap();
    assert!(full_cols > 100, "the pane fills the window: {full_cols} columns");

    // Split: two shells side by side, the new one focused and narrower.
    let split = read(data, "split.json");
    let p = panes(&split);
    assert_eq!(p.len(), 2);
    assert_eq!(p[1]["focused"], true);
    assert!(p[1]["cols"].as_u64().unwrap() < full_cols / 2 + 2);
    assert_eq!(split["terminal"]["sessions_running"], 2);

    // Ctrl+Shift+W closed the focused pane (and its shell).
    let closed = read(data, "closed.json");
    assert_eq!(panes(&closed).len(), 1);
    assert_eq!(closed["terminal"]["sessions_running"], 1);

    // Ctrl+Shift+T opened a second tab; its close button closed it.
    let tabs = read(data, "tabs.json");
    assert_eq!(tabs["terminal"]["tabs"].as_array().unwrap().len(), 2);
    assert_eq!(tabs["terminal"]["active"], 1);

    // `exit` ends the shell; the pane says so; Enter closes it.
    let exited = read(data, "exited.json");
    let p = panes(&exited);
    assert_eq!(p.len(), 1, "{exited:#}");
    assert_eq!(p[0]["exited"]["code"], 5, "{exited:#}");
    let none = read(data, "none.json");
    assert_eq!(none["terminal"]["tabs"].as_array().unwrap().len(), 0);
    assert_eq!(none["terminal"]["sessions_running"], 0);

    // And a new one can be opened.
    let again = read(data, "reopened.json");
    assert_eq!(panes(&again).len(), 1);
}

#[test]
fn each_workspace_has_its_own_terminals() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    pin_shell(&data);
    let (pa, pb) = (dir.path().join("term-a"), dir.path().join("term-b"));
    std::fs::create_dir_all(&pa).unwrap();
    std::fs::create_dir_all(&pb).unwrap();
    let t = TERM;
    let script = format!(
        "frames 3\n\
         click new-ws\ntype a\nkey Enter\nframes 3\nclick link\ntype {pa}\nkey Enter\nframes 3\nclick env\ntype WHO=from-a\nkey Enter\nframes 3\n\
         click new-ws\ntype b\nkey Enter\nframes 3\nclick link\ntype {pb}\nkey Enter\nframes 3\nclick env\ntype WHO=from-b\nkey Enter\nframes 3\n\
         click ws:a\nframes 3\nclick nav:terminal\nframes 5\nwait-screen {prompt}\n\
         type {who}\nkey Enter\nwait-screen from-a\ntype {pwd}\nkey Enter\nwait 1000\nframes 2\ndump a1.json\n\
         click nav:home\nframes 3\nclick ws:b\nframes 3\nclick nav:terminal\nframes 5\nwait-screen {prompt}\n\
         type {who}\nkey Enter\nwait-screen from-b\ntype {pwd}\nkey Enter\nwait 1000\nframes 2\ndump b1.json\n\
         click nav:home\nframes 3\nclick ws:a\nframes 3\nclick nav:terminal\nframes 5\ndump a2.json\n",
        pa = pa.display(),
        pb = pb.display(),
        prompt = t.prompt,
        who = t.who,
        pwd = t.pwd,
    );
    assert_eq!(drive(&data, &script, "1400x800"), 0);
    let canon = |p: &Path| {
        let c = p.canonicalize().unwrap().display().to_string();
        c.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(c)
    };
    let text = |s: &Value| panes(s)[0]["text"].as_str().unwrap().to_owned();
    let (a1, b1, a2) = (read(&data, "a1.json"), read(&data, "b1.json"), read(&data, "a2.json"));

    assert!(text(&a1).lines().any(|l| l.trim() == "from-a"), "{}", text(&a1));
    assert!(text(&a1).contains(&canon(&pa)), "{}", text(&a1));
    assert!(text(&b1).lines().any(|l| l.trim() == "from-b"), "{}", text(&b1));
    assert!(text(&b1).contains(&canon(&pb)), "{}", text(&b1));
    assert!(!text(&b1).contains("from-a"), "b's terminal shows nothing of a's");
    // Both shells kept running; back in a, it's a's same session.
    assert_eq!(b1["terminal"]["sessions_running"], 2);
    assert_eq!(panes(&a2)[0]["session"], panes(&a1)[0]["session"]);
    assert!(text(&a2).lines().any(|l| l.trim() == "from-a"));
}

// ── the shell: navigation and settings ──────────────────────────────────

#[test]
fn shortcuts_open_views_and_planned_areas_do_nothing() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    let script = "frames 3\nkey Ctrl+2\nframes 3\ndump run.json\nkey Escape\nframes 2\n\
                  click nav:home\nframes 3\nkey Ctrl+,\nframes 3\ndump settings-view.json\n\
                  click nav:editor\nframes 3\nclick nav:plugins\nframes 3\nclick nav:language\nframes 3\ndump planned.json\n\
                  click nav:home\nframes 3\nkey Ctrl+3\nframes 5\ndump terminal.json\n";
    assert_eq!(drive(data, script, "1100x700"), 0);
    // Ctrl+2 opened Run (and its prompt took the keyboard).
    assert_eq!(read(data, "run.json")["view"], "run");
    assert_eq!(read(data, "settings-view.json")["view"], "settings");
    // The editor, plugins and language tools are shown but not built:
    // clicking them leaves you where you were.
    assert_eq!(read(data, "planned.json")["view"], "settings");
    assert_eq!(read(data, "terminal.json")["view"], "terminal");
}

#[test]
fn settings_save_as_they_change() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    let script = "frames 3\nclick nav:settings\nframes 3\nclick setting:font+\nframes 2\nclick setting:font+\nframes 2\nclick setting:font-\nframes 2\n\
                  click setting:restore\nframes 3\n";
    assert_eq!(drive(data, script, "1100x700"), 0);
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["data"]["font_size"], 15.0, "{saved:#}");
    assert_eq!(saved["data"]["restore_session"], false, "{saved:#}");
}

#[test]
fn workspaces_can_be_renamed_closed_and_removed() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let script = "frames 3\n\
                  click new-ws\ntype first\nkey Enter\nframes 3\nclick new-ws\ntype second\nkey Enter\nframes 3\n\
                  click ws-rename\nframes 2\nkey Ctrl+A\ntype renamed\nkey Enter\nframes 3\ndump renamed.json\n\
                  click ws-close\nframes 3\ndump closed.json\n\
                  click ws:first\nframes 3\nclick ws-remove\nframes 2\ndump confirm.json\nclick ws-remove\nframes 3\ndump removed.json\n";
    assert_eq!(drive(&data, script, "1200x760"), 0);
    let renamed = read(&data, "renamed.json");
    assert_eq!(renamed["active"]["name"], "renamed", "{renamed:#}");
    assert_eq!(renamed["on_disk"], serde_json::json!(["first", "renamed"]));
    let closed = read(&data, "closed.json");
    assert!(closed["active"].is_null(), "closing leaves no workspace active");
    assert_eq!(closed["on_disk"], serde_json::json!(["first", "renamed"]), "closing keeps it");
    // One click arms "Remove"; the second removes.
    assert_eq!(read(&data, "confirm.json")["on_disk"], serde_json::json!(["first", "renamed"]));
    let removed = read(&data, "removed.json");
    assert_eq!(removed["on_disk"], serde_json::json!(["renamed"]), "{removed:#}");
    assert!(data.join("workspaces/.removed").is_dir(), "the record is kept aside");
}

#[test]
fn the_terminal_scrollback_can_be_searched() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    pin_shell(data);
    let rows = if cfg!(windows) { "for /L %i in (1,1,90) do @echo line-%i" } else { "i=1; while [ $i -le 90 ]; do echo line-$i; i=$((i+1)); done" };
    let script = format!(
        "frames 3\nclick nav:terminal\nframes 5\nwait-screen {prompt}\n\
         type echo findme-early\nkey Enter\nwait 800\n\
         type {rows}\nkey Enter\nwait-screen line-90\nframes 3\n\
         key Ctrl+Shift+F\nframes 4\ntype FINDME\nframes 4\ndump found.json\nsnapshot search.png\n\
         click term-search-prev\nframes 3\ndump stepped.json\n\
         click term-search-close\nframes 3\ndump closed.json\n",
        prompt = TERM.prompt,
    );
    assert_eq!(drive(data, &script, "1100x640"), 0);
    let found = read(data, "found.json");
    // The command line and its output both contain it (case ignored).
    assert_eq!(found["search"]["query"], "FINDME");
    assert!(found["search"]["matches"].as_u64().unwrap() >= 2, "{:#}", found["search"]);
    let stepped = read(data, "stepped.json");
    assert_ne!(stepped["search"]["current"], found["search"]["current"], "stepping moves to another match");
    assert!(read(data, "closed.json")["search"].is_null());
    let keep = Path::new(env!("CARGO_TARGET_TMPDIR")).join("drive-artifacts");
    std::fs::create_dir_all(&keep).unwrap();
    let _ = std::fs::copy(data.join("search.png"), keep.join("terminal-search.png"));
}

/// A program that asks for the mouse gets clicks as escape sequences:
/// bash switches SGR mouse reporting on, reads up to the end of one report,
/// and prints what it got.
#[cfg(unix)]
#[test]
fn clicks_reach_programs_that_ask_for_the_mouse() {
    if !has_display() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    pin_shell(data);
    let reader = r#"bash -c 'printf "\033[?1000h\033[?1006h"; IFS= read -rsd M x; printf "\033[?1000l"; printf "got:%s\n" "${x#?}"'"#;
    let script = format!(
        "frames 3\nclick nav:terminal\nframes 5\nwait-screen $\ntype {reader}\nkey Enter\nwait 1500\nclick term-pane:0\nwait-screen got:[<0;\ndump mouse.json\n"
    );
    assert_eq!(drive(data, &script, "1000x600"), 0);
    let text = read(data, "mouse.json")["terminal"]["tabs"][0]["panes"][0]["text"].as_str().unwrap().to_owned();
    let line = text.lines().find(|l| l.starts_with("got:")).expect("bash printed the report");
    // got:[<0;COL;ROW — a left press at a real cell, 1-based.
    let nums: Vec<u32> = line.trim_start_matches("got:[<").split(';').map(|n| n.parse().unwrap()).collect();
    assert_eq!(nums[0], 0, "{line}");
    assert!(nums[1] >= 1 && nums[2] >= 1, "{line}");
}
