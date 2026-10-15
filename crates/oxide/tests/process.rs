//! The process engine against real processes (cmd on Windows, sh on Unix).

use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use oxide::events::{Event, EventBus, Stream};
use oxide::ids::{ProcessId, WorkspaceId};
use oxide::process::{ProcessEngine, ProcessSpec, Status};

/// A shell command line, run the platform's way.
fn shell(script: &str) -> ProcessSpec {
    if cfg!(windows) {
        ProcessSpec::new("cmd").args(["/D", "/C", script])
    } else {
        ProcessSpec::new("sh").args(["-c", script])
    }
}

/// Everything the process printed, in order, until it exited.
fn collect(rx: &Receiver<Event>, id: ProcessId) -> (Vec<(Stream, String)>, Option<i32>, bool) {
    let mut lines = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left).expect("the process should have exited") {
            Event::ProcessOutput { id: i, stream, line } if i == id => lines.push((stream, line)),
            Event::ProcessExited { id: i, code, cancelled } if i == id => return (lines, code, cancelled),
            _ => {}
        }
    }
}

#[test]
fn streams_output_and_reports_success() {
    let bus = EventBus::new();
    let rx = bus.subscribe();
    let engine = ProcessEngine::new(bus);
    let id = engine.spawn(shell("echo one && echo two")).unwrap();
    let (lines, code, cancelled) = collect(&rx, id);
    let out: Vec<_> = lines.iter().filter(|(s, _)| *s == Stream::Stdout).map(|(_, l)| l.trim().to_owned()).collect();
    assert_eq!(out, vec!["one", "two"]);
    assert_eq!(code, Some(0));
    assert!(!cancelled);
    assert!(engine.status(id).unwrap().succeeded());
}

#[test]
fn failure_is_a_failure() {
    let engine = ProcessEngine::new(EventBus::new());
    let id = engine.spawn(shell("exit 3")).unwrap();
    let status = engine.wait(id, Duration::from_secs(20)).unwrap();
    assert_eq!(status, Status::Exited { code: Some(3), cancelled: false });
    assert!(!status.succeeded());
}

#[test]
fn stderr_is_kept_apart() {
    let bus = EventBus::new();
    let rx = bus.subscribe();
    let engine = ProcessEngine::new(bus);
    let id = engine.spawn(shell("echo oops 1>&2")).unwrap();
    let (lines, _, _) = collect(&rx, id);
    assert!(lines.iter().any(|(s, l)| *s == Stream::Stderr && l.trim() == "oops"), "{lines:?}");
}

#[test]
fn input_reaches_the_process() {
    let bus = EventBus::new();
    let rx = bus.subscribe();
    let engine = ProcessEngine::new(bus);
    let script = if cfg!(windows) { "set /p X=& call echo got %X%" } else { "read x; echo got $x" };
    let id = engine.spawn(shell(script)).unwrap();
    engine.write_input(id, b"hello\n").unwrap();
    engine.close_input(id).unwrap();
    let (lines, code, _) = collect(&rx, id);
    assert!(lines.iter().any(|(_, l)| l.trim() == "got hello"), "{lines:?}");
    assert_eq!(code, Some(0));
}

#[test]
fn cancel_stops_a_long_running_process_tree() {
    let engine = ProcessEngine::new(EventBus::new());
    // A shell that starts a child which would run for a minute.
    let script = if cfg!(windows) { "ping -n 60 127.0.0.1 >NUL" } else { "sleep 60; echo late" };
    let started = Instant::now();
    let id = engine.spawn(shell(script)).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(engine.status(id).unwrap(), Status::Running);
    engine.cancel(id).unwrap();
    let status = engine.wait(id, Duration::from_secs(10)).unwrap();
    assert!(matches!(status, Status::Exited { cancelled: true, .. }), "{status:?}");
    assert!(!status.succeeded());
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn a_missing_program_is_reported_by_name() {
    let engine = ProcessEngine::new(EventBus::new());
    let err = engine.spawn(ProcessSpec::new("definitely-not-a-real-program-oxis")).unwrap_err();
    assert!(err.to_string().contains("definitely-not-a-real-program-oxis"), "{err}");
}

#[test]
fn cancelling_a_workspace_stops_only_its_processes() {
    let engine = ProcessEngine::new(EventBus::new());
    let (a, b) = (WorkspaceId::next(), WorkspaceId::next());
    let long = if cfg!(windows) { "ping -n 60 127.0.0.1 >NUL" } else { "sleep 60" };
    let pa = engine.spawn(shell(long).owner(a)).unwrap();
    let pb = engine.spawn(shell(long).owner(b)).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(engine.cancel_owned_by(a), 1);
    assert!(matches!(engine.wait(pa, Duration::from_secs(10)).unwrap(), Status::Exited { cancelled: true, .. }));
    assert_eq!(engine.status(pb).unwrap(), Status::Running);
    engine.cancel(pb).unwrap();
    engine.wait(pb, Duration::from_secs(10)).unwrap();
}

#[test]
fn many_processes_at_once() {
    let bus = EventBus::new();
    let engine = ProcessEngine::new(bus);
    let ids: Vec<_> = (0..8).map(|i| engine.spawn(shell(&format!("echo {i}"))).unwrap()).collect();
    for id in ids {
        assert!(engine.wait(id, Duration::from_secs(20)).unwrap().succeeded());
    }
}

#[test]
fn environment_and_working_directory_apply() {
    let bus = EventBus::new();
    let rx = bus.subscribe();
    let engine = ProcessEngine::new(bus);
    let dir = tempfile::tempdir().unwrap();
    let script = if cfg!(windows) { "echo %OXIS_TEST_VAR% & cd" } else { "echo $OXIS_TEST_VAR; pwd" };
    let id = engine.spawn(shell(script).env("OXIS_TEST_VAR", "from-oxis").cwd(dir.path())).unwrap();
    let (lines, _, _) = collect(&rx, id);
    let text: Vec<String> = lines.into_iter().map(|(_, l)| l.trim().to_owned()).collect();
    assert_eq!(text[0], "from-oxis");
    let want = std::fs::canonicalize(dir.path()).unwrap();
    let got = std::fs::canonicalize(&text[1]).unwrap();
    assert_eq!(got, want);
}

#[test]
fn ended_processes_are_forgotten_beyond_a_limit_but_running_ones_never() {
    let bus = EventBus::new();
    let mut engine = ProcessEngine::new(bus);
    engine.set_keep_exited(3);
    let long = engine.spawn(shell(if cfg!(windows) { "ping -n 30 127.0.0.1 >NUL" } else { "sleep 30" })).unwrap();
    let mut done = Vec::new();
    for _ in 0..6 {
        let id = engine.spawn(shell("exit 0")).unwrap();
        assert!(engine.wait(id, Duration::from_secs(20)).unwrap().succeeded());
        done.push(id);
    }
    let known: Vec<_> = engine.list().into_iter().map(|p| p.id).collect();
    assert!(known.contains(&long), "a running process is never forgotten");
    // Room is made when a process starts, so the last three ended ones remain.
    assert_eq!(known.len(), 1 + 3, "{known:?}");
    for id in &done[3..] {
        assert!(known.contains(id));
    }
    assert!(matches!(engine.status(done[0]), Err(oxide::Error::NoProcess(_))));
    engine.cancel(long).unwrap();
    assert!(engine.wait(long, Duration::from_secs(10)).unwrap() != Status::Running);
}

/// A process that escapes the kill (here, a daemon in its own session)
/// keeps the output pipe open; the cancel must still be reported.
#[cfg(unix)]
#[test]
fn a_cancel_is_reported_even_if_something_escaped_with_the_output_pipe() {
    let bus = EventBus::new();
    let rx = bus.subscribe();
    let engine = ProcessEngine::new(bus);
    let id = engine.spawn(shell("setsid sleep 20 & echo started; sleep 30")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !matches!(rx.recv_timeout(Duration::from_secs(10)), Ok(Event::ProcessOutput { id: i, .. }) if i == id) {
        assert!(Instant::now() < deadline, "no output");
    }
    let started = Instant::now();
    engine.cancel(id).unwrap();
    let status = engine.wait(id, Duration::from_secs(10)).unwrap();
    assert_eq!(status, Status::Exited { code: None, cancelled: true });
    assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
}
