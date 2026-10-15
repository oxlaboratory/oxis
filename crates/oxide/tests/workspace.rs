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
    let long =
        if cfg!(windows) { ProcessSpec::new("cmd").args(["/D", "/C", "ping -n 60 127.0.0.1 >NUL"]) } else { ProcessSpec::new("sh").args(["-c", "sleep 60"]) };
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

/// `git` with no config of the user's, or `None` if Git isn't installed.
fn git(dir: &std::path::Path, args: &[&str]) -> Option<()> {
    let ok = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().ok()?.status.success();
    ok.then_some(())
}

#[test]
fn linking_a_folder_records_its_git_remote() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    if git(&a, &["init", "-q"]).is_none() {
        eprintln!("git isn't installed; skipping");
        return;
    }
    git(&a, &["remote", "add", "origin", "https://example.com/a.git"]).unwrap();
    git(&b, &["init", "-q"]).unwrap();
    git(&b, &["remote", "add", "upstream", "https://example.com/b.git"]).unwrap();

    let mut engine = Engine::open(dir.path().join("data")).unwrap();
    let wa = engine.workspaces.create("a", WorkspaceData::default()).unwrap();
    let wb = engine.workspaces.create("b", WorkspaceData::default()).unwrap();
    engine.link_folder(wa, &a).unwrap();
    engine.link_folder(wb, &b).unwrap();
    assert_eq!(engine.workspaces.get(wa).unwrap().data.git_remote.as_deref(), Some("https://example.com/a.git"));
    assert_eq!(engine.workspaces.get(wb).unwrap().data.git_remote.as_deref(), Some("https://example.com/b.git"), "no origin: the first remote");

    // Relinking to a repository without remotes forgets the old remote.
    // (A repository of its own, so a repository the temp folder happens to
    // sit in isn't found instead.)
    let plain = dir.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    git(&plain, &["init", "-q"]).unwrap();
    engine.link_folder(wa, &plain).unwrap();
    assert_eq!(engine.workspaces.get(wa).unwrap().data.git_remote, None);
    assert!(!engine.workspaces.get(wa).unwrap().data.folder.as_ref().unwrap().to_string_lossy().starts_with(r"\?\"));

    assert!(matches!(engine.link_folder(wa, dir.path().join("nope")), Err(Error::NotAFolder(_))));
}

#[test]
fn environment_variables_are_validated_and_kept_per_workspace() {
    use oxide::workspace::parse_env_assignment;
    assert_eq!(parse_env_assignment(" PORT = 3000 ").unwrap(), ("PORT".into(), "3000".into()));
    assert_eq!(parse_env_assignment("URL=a=b").unwrap(), ("URL".into(), "a=b".into()));
    assert!(matches!(parse_env_assignment("PORT"), Err(Error::BadEnvVar(..))));
    assert!(matches!(parse_env_assignment("=1"), Err(Error::BadEnvVar(..))));
    assert!(matches!(parse_env_assignment("MY VAR=1"), Err(Error::BadEnvVar(..))));

    let dir = tempfile::tempdir().unwrap();
    let mut engine = Engine::open(dir.path()).unwrap();
    let a = engine.workspaces.create("a", WorkspaceData::default()).unwrap();
    let b = engine.workspaces.create("b", WorkspaceData::default()).unwrap();
    engine.set_env(a, "PORT", Some("3000")).unwrap();
    engine.set_env(b, "PORT", Some("4000")).unwrap();
    engine.set_env(a, "ONLY_A", Some("1")).unwrap();
    engine.set_env(a, "ONLY_A", None).unwrap();
    assert!(engine.set_env(a, "BAD=KEY", Some("1")).is_err());
    drop(engine);

    let mut engine = Engine::open(dir.path()).unwrap();
    let a = engine.workspaces.open("a").unwrap();
    let b = engine.workspaces.open("b").unwrap();
    let env = |id| engine.workspaces.get(id).unwrap().data.env.clone();
    assert_eq!(env(a).into_iter().collect::<Vec<_>>(), vec![("PORT".to_owned(), "3000".to_owned())]);
    assert_eq!(env(b).into_iter().collect::<Vec<_>>(), vec![("PORT".to_owned(), "4000".to_owned())]);
}

#[test]
fn a_failed_save_leaves_the_workspace_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut ws = WorkspaceEngine::new(dir.path().join("workspaces"), oxide::events::EventBus::new());
    let id = ws.create("api", WorkspaceData::default()).unwrap();
    // Make the workspace's folder unwritable by replacing it with a file.
    let folder = dir.path().join("workspaces").join("api");
    std::fs::remove_dir_all(&folder).unwrap();
    std::fs::write(&folder, "not a folder").unwrap();
    assert!(ws.update(id, |d| d.git_remote = Some("x".into())).is_err());
    assert_eq!(ws.get(id).unwrap().data.git_remote, None);
}

#[test]
fn a_workspace_whose_folder_is_gone_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let mut engine = Engine::open(dir.path().join("data")).unwrap();
    let id = engine.workspaces.create("api", WorkspaceData::default()).unwrap();
    engine.link_folder(id, &project).unwrap();
    std::fs::remove_dir_all(&project).unwrap();
    let err = engine.spawn_in(id, ProcessSpec::new("git").arg("--version")).unwrap_err();
    assert!(matches!(err, Error::NotAFolder(_)), "{err}");
    assert!(err.to_string().contains("isn't a folder"));
}
