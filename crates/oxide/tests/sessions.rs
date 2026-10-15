//! Terminal sessions through the engine: ownership, workspace folders and
//! environments, events, and closing.

use std::time::{Duration, Instant};

use oxide::events::Event;
use oxide::workspace::WorkspaceData;
use oxide::{Engine, Error};

/// cmd on Windows (its output is predictable), sh elsewhere.
fn engine(dir: &std::path::Path) -> Engine {
    let mut e = Engine::open(dir).unwrap();
    e.settings.shell = if cfg!(windows) { "cmd".into() } else { "sh".into() };
    e
}

fn wait_for_line(engine: &Engine, id: oxide::ids::SessionId, line: &str) {
    let t = engine.terminals.get(id).unwrap().terminal;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let s = t.screen();
        if (0..s.rows).any(|r| s.line(r).trim() == line) {
            return;
        }
        assert!(Instant::now() < deadline, "no `{line}` on screen:\n{}", s.text());
        std::thread::sleep(Duration::from_millis(30));
    }
}

/// Waits for the shell's prompt (`>` from cmd, `$` from sh) on the last
/// line, then types `line` — typing before the prompt shows would mix the
/// prompt into the output line.
fn type_at_prompt(engine: &Engine, id: oxide::ids::SessionId, line: &str) {
    let t = engine.terminals.get(id).unwrap().terminal;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let text = t.screen().text();
        let last = text.lines().last().unwrap_or("").trim_end();
        if last.ends_with('>') || last.ends_with('$') {
            break;
        }
        assert!(Instant::now() < deadline, "no prompt:\n{text}");
        std::thread::sleep(Duration::from_millis(30));
    }
    t.write(format!("{line}\r").as_bytes());
}

#[test]
fn sessions_run_in_their_workspace_and_end_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let (pa, pb) = (dir.path().join("a"), dir.path().join("b"));
    std::fs::create_dir_all(&pa).unwrap();
    std::fs::create_dir_all(&pb).unwrap();
    let mut engine = engine(&dir.path().join("data"));
    let rx = engine.bus.subscribe();
    let a = engine.workspaces.create("a", WorkspaceData::default()).unwrap();
    let b = engine.workspaces.create("b", WorkspaceData::default()).unwrap();
    engine.link_folder(a, &pa).unwrap();
    engine.link_folder(b, &pb).unwrap();
    engine.set_env(a, "WHO", Some("alpha")).unwrap();
    engine.set_env(b, "WHO", Some("beta")).unwrap();

    let ta = engine.open_terminal(Some(a), 100, 30).unwrap();
    let tb = engine.open_terminal(Some(b), 100, 30).unwrap();
    assert_eq!(engine.terminals.owned_by(Some(a)).iter().map(|s| s.id).collect::<Vec<_>>(), vec![ta]);
    assert_eq!(engine.terminals.owned_by(Some(b)).iter().map(|s| s.id).collect::<Vec<_>>(), vec![tb]);

    let show = if cfg!(windows) { "echo %WHO%" } else { "echo $WHO" };
    for (id, who) in [(ta, "alpha"), (tb, "beta")] {
        type_at_prompt(&engine, id, show);
        wait_for_line(&engine, id, who);
    }

    // Closing a ends a's session, and only a's.
    assert_eq!(engine.close_workspace(a).unwrap(), 1);
    assert!(engine.terminals.get(ta).is_none());
    assert!(engine.terminals.get(tb).unwrap().terminal.exit_status().is_none());

    let events: Vec<Event> = rx.try_iter().collect();
    assert!(events.iter().any(|e| matches!(e, Event::SessionStarted { id, owner: Some(o), .. } if *id == ta && *o == a)));
    assert!(events.iter().any(|e| matches!(e, Event::SessionOutput { id } if *id == tb)));
    assert!(events.iter().any(|e| matches!(e, Event::SessionClosed { id } if *id == ta)));
    engine.terminals.close_all();
}

#[test]
fn an_exit_is_announced_and_the_session_stays_readable() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path());
    let rx = engine.bus.subscribe();
    let id = engine.open_terminal(None, 80, 24).unwrap();
    let t = engine.terminals.get(id).unwrap().terminal;
    type_at_prompt(&engine, id, "echo bye");
    wait_for_line(&engine, id, "bye");
    type_at_prompt(&engine, id, "exit 4");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Event::SessionExited { id: i, code }) if i == id => {
                assert_eq!(code, Some(4));
                break;
            }
            Ok(_) => assert!(Instant::now() < deadline),
            Err(e) => panic!("no exit event: {e}"),
        }
    }
    assert!(engine.terminals.get(id).unwrap().terminal.screen().text().contains("bye"));
    engine.terminals.close(id).unwrap();
    assert!(matches!(engine.terminals.close(id), Err(Error::NoSession(_))));
}

#[test]
fn a_shell_that_isnt_installed_is_named() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = Engine::open(dir.path()).unwrap();
    engine.settings.shell = "definitely-not-a-shell".into();
    let err = engine.open_terminal(None, 80, 24).unwrap_err();
    assert!(matches!(&err, Error::NoShell(s) if s == "definitely-not-a-shell"), "{err}");
    assert!(matches!(engine.run_command(None, "echo hi"), Err(Error::NoShell(_))));
}

#[test]
fn run_command_uses_the_chosen_shell() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine(dir.path());
    let id = engine.run_command(None, "echo via-shell").unwrap();
    let status = engine.processes.wait(id, Duration::from_secs(20)).unwrap();
    assert!(status.succeeded(), "{status:?}");
}
