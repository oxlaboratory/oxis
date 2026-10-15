//! Workspaces on real files, and the engine's rules across subsystems.

use std::time::Duration;

use oxide::events::Event;
use oxide::process::{ProcessSpec, Status};
use oxide::workspace::{validate_name, WorkspaceData, WorkspaceEngine};
use oxide::{Engine, Error};

#[test]
fn create_list_open_rename_close() {
    let dir = tempfile::tempdir().unwrap();
    let bus = oxide::events::EventBus::new();
    let rx = bus.subscribe();
    let mut ws = WorkspaceEngine::new(dir.path().join("workspaces"), bus);
    assert!(ws.list().unwrap().is_empty());

    let api = ws.create("api", WorkspaceData::default()).unwrap();
    let web = ws.create("web", WorkspaceData::default()).unwrap();
    assert_eq!(ws.list().unwrap(), vec!["api", "web"]);
    assert!(matches!(ws.create("api", WorkspaceData::default()), Err(Error::WorkspaceExists(_))));

    ws.activate(web).unwrap();
    assert_eq!(ws.active().unwrap().name, "web");
    ws.rename(web, "frontend").unwrap();
    assert_eq!(ws.list().unwrap(), vec!["api", "frontend"]);
    assert_eq!(ws.active().unwrap().name, "frontend");

    ws.close(web).unwrap();
    assert!(ws.active().is_none());
    assert_eq!(ws.open("api").unwrap(), api, "opening an open workspace returns it");

    let events: Vec<Event> = rx.try_iter().collect();
    assert!(events.iter().any(|e| matches!(e, Event::WorkspaceRenamed { to, .. } if to == "frontend")));
    assert!(events.iter().any(|e| matches!(e, Event::WorkspaceClosed { name, .. } if name == "frontend")));
}

#[test]
fn workspaces_never_share_a_git_remote_or_settings() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspaces");
    let mut ws = WorkspaceEngine::new(&root, Default::default());
    let a = ws.create("a", WorkspaceData::default()).unwrap();
    let b = ws.create("b", WorkspaceData::default()).unwrap();
    ws.update(a, |d| d.git_remote = Some("github:acme/a".into())).unwrap();
    ws.activate(b).unwrap();
    ws.update(b, |d| {
        d.git_remote = Some("github:acme/b".into());
        d.env.insert("MODE".into(), "b".into());
    })
    .unwrap();
    ws.activate(a).unwrap();
    assert_eq!(ws.get(a).unwrap().data.git_remote.as_deref(), Some("github:acme/a"));
    assert!(ws.get(a).unwrap().data.env.is_empty());

    // And on disk, after a restart.
    let mut again = WorkspaceEngine::new(&root, Default::default());
    let a2 = again.open("a").unwrap();
    let b2 = again.open("b").unwrap();
    assert_eq!(again.get(a2).unwrap().data.git_remote.as_deref(), Some("github:acme/a"));
    assert_eq!(again.get(b2).unwrap().data.git_remote.as_deref(), Some("github:acme/b"));
}

#[test]
fn names_that_cant_be_folders_are_refused() {
    for bad in ["", "  ", ".", "..", "a/b", "a\\b", "c:", "what?", "trailing.", "trailing ", &"x".repeat(65)] {
        assert!(validate_name(bad).is_err(), "{bad:?} should be refused");
    }
    for good in ["api", "acme web", "v2-rewrite", "日本語"] {
        assert!(validate_name(good).is_ok(), "{good:?} should be fine");
    }
}

#[test]
fn closing_a_workspace_stops_its_processes() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = Engine::open(dir.path()).unwrap();
    let a = engine.workspaces.create("a", WorkspaceData::default()).unwrap();
    let b = engine.workspaces.create("b", WorkspaceData::default()).unwrap();
    let long = if cfg!(windows) {
        ProcessSpec::new("cmd").args(["/D", "/C", "ping -n 60 127.0.0.1 >NUL"])
    } else {
        ProcessSpec::new("sh").args(["-c", "sleep 60"])
    };
    let pa = engine.spawn_in(a, long.clone()).unwrap();
    let pb = engine.spawn_in(b, long).unwrap();
    std::thread::sleep(Duration::from_millis(200));

    assert_eq!(engine.close_workspace(a).unwrap(), 1);
    assert!(matches!(engine.processes.wait(pa, Duration::from_secs(10)).unwrap(), Status::Exited { cancelled: true, .. }));
    assert_eq!(engine.processes.status(pb).unwrap(), Status::Running, "b's process is untouched");
    engine.close_workspace(b).unwrap();
    engine.processes.wait(pb, Duration::from_secs(10)).unwrap();
}

#[test]
fn a_workspace_runs_things_in_its_folder_with_its_environment() {
    let dir = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let mut engine = Engine::open(dir.path()).unwrap();
    let rx = engine.bus.subscribe();
    let mut data = WorkspaceData { folder: Some(project.path().to_owned()), ..Default::default() };
    data.env.insert("OXIS_WS".into(), "acme".into());
    let ws = engine.workspaces.create("acme", data).unwrap();
    let script = if cfg!(windows) { "echo %OXIS_WS% & cd" } else { "echo $OXIS_WS; pwd" };
    let spec = if cfg!(windows) { ProcessSpec::new("cmd").args(["/D", "/C", script]) } else { ProcessSpec::new("sh").args(["-c", script]) };
    let id = engine.spawn_in(ws, spec).unwrap();
    assert!(engine.processes.wait(id, Duration::from_secs(20)).unwrap().succeeded());
    let lines: Vec<String> = rx
        .try_iter()
        .filter_map(|e| match e {
            Event::ProcessOutput { id: i, line, .. } if i == id => Some(line.trim().to_owned()),
            _ => None,
        })
        .collect();
    assert_eq!(lines[0], "acme");
    assert_eq!(std::fs::canonicalize(&lines[1]).unwrap(), std::fs::canonicalize(project.path()).unwrap());
}

#[test]
fn settings_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut engine = Engine::open(dir.path()).unwrap();
        engine.settings.theme = "ember".into();
        engine.save_settings().unwrap();
    }
    assert_eq!(Engine::open(dir.path()).unwrap().settings.theme, "ember");
}
