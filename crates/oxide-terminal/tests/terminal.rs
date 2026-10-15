//! Terminals running real shells in real pseudo-terminals: cmd on Windows
//! (through ConPTY), sh on Unix.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use oxide_terminal::{Notice, Screen, SpawnError, Terminal, TerminalCommand};

fn shell() -> TerminalCommand {
    if cfg!(windows) {
        TerminalCommand { program: "cmd.exe".into(), args: vec!["/Q".into()], ..Default::default() }
    } else {
        TerminalCommand { program: "/bin/sh".into(), env: vec![("PS1".into(), "$ ".into()), ("ENV".into(), String::new())], ..Default::default() }
    }
}

fn spawn(cmd: TerminalCommand, cols: u16, rows: u16) -> (Terminal, Arc<Mutex<Vec<Notice>>>) {
    let notices = Arc::new(Mutex::new(Vec::new()));
    let n = notices.clone();
    let t = Terminal::spawn(cmd, cols, rows, move |e| n.lock().unwrap().push(e)).expect("the shell should start");
    (t, notices)
}

/// Waits until the screen satisfies `pred`, or fails showing the screen.
fn wait_for(t: &Terminal, what: &str, pred: impl Fn(&Screen) -> bool) -> Screen {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let s = t.screen();
        if pred(&s) {
            return s;
        }
        if Instant::now() > deadline {
            panic!("timed out waiting for {what}; the screen shows:\n{}", s.text());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn has_line(s: &Screen, line: &str) -> bool {
    (0..s.rows).any(|r| s.line(r).trim() == line)
}

/// Types a command once the prompt (`>` or `$`) is on the last line, so
/// the prompt and the command's output don't share a line.
fn run(t: &Terminal, line: &str) {
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
fn runs_a_command_and_shows_its_output() {
    let (t, notices) = spawn(shell(), 80, 24);
    run(&t, "echo hello-terminal");
    let s = wait_for(&t, "the output", |s| has_line(s, "hello-terminal"));
    assert_eq!((s.cols, s.rows), (80, 24));
    assert!(notices.lock().unwrap().contains(&Notice::Output));
    assert_eq!(t.exit_status(), None);
    t.kill();
}

#[test]
fn reports_the_exit_code() {
    let (t, notices) = spawn(shell(), 80, 24);
    run(&t, "exit 7");
    assert_eq!(t.wait(Duration::from_secs(20)), Some(Some(7)));
    // The exit notice follows (it's sent right after the status is set).
    let deadline = Instant::now() + Duration::from_secs(5);
    while !notices.lock().unwrap().contains(&Notice::Exited(Some(7))) {
        assert!(Instant::now() < deadline, "{:?}", notices.lock().unwrap());
        std::thread::sleep(Duration::from_millis(20));
    }
    // Input after the end goes nowhere, without failing.
    t.write(b"echo too late\r");
}

#[test]
fn the_shell_sees_the_size_and_its_changes() {
    let (t, _) = spawn(shell(), 80, 24);
    let ask = if cfg!(windows) { "mode con" } else { "stty size" };
    t.resize(57, 13);
    assert_eq!(t.size(), (57, 13));
    run(&t, ask);
    let s = wait_for(&t, "the new size", |s| {
        let text = s.text();
        if cfg!(windows) {
            text.lines().any(|l| l.contains("Columns:") && l.trim_end().ends_with("57"))
        } else {
            has_line(s, "13 57")
        }
    });
    assert_eq!((s.cols, s.rows), (57, 13));
    t.kill();
}

#[test]
fn long_output_scrolls_into_history_and_back() {
    let (t, _) = spawn(shell(), 60, 10);
    let count = if cfg!(windows) { "for /L %i in (1,1,120) do @echo line-%i" } else { "i=1; while [ $i -le 120 ]; do echo line-$i; i=$((i+1)); done" };
    run(&t, count);
    let s = wait_for(&t, "the last line", |s| has_line(s, "line-120"));
    assert!(s.history >= 100, "history {}", s.history);
    assert_eq!(s.scrolled, 0);

    t.scroll(50);
    let s = t.screen();
    assert_eq!(s.scrolled, 50);
    assert!(s.cursor.is_none() || s.scrolled == 0, "the cursor is off screen when scrolled back");
    assert!(!has_line(&s, "line-120"));

    // Typing returns to the bottom.
    t.write(b" ");
    assert_eq!(t.screen().scrolled, 0);
    t.kill();
}

#[test]
fn selecting_copies_the_text() {
    let (t, _) = spawn(shell(), 80, 24);
    run(&t, "echo pick-me-up");
    let s = wait_for(&t, "the output", |s| has_line(s, "pick-me-up"));
    let row = (0..s.rows).find(|&r| s.line(r).trim() == "pick-me-up").unwrap();
    t.select((row, 0), (row, 9));
    assert_eq!(t.selection_text().as_deref(), Some("pick-me-up"));
    assert!(t.screen().cell(row, 3).flags.has(oxide_terminal::CellFlags::SELECTED));
    t.clear_selection();
    assert_eq!(t.selection_text(), None);
    t.kill();
}

#[test]
fn colours_come_through() {
    let (t, _) = spawn(shell(), 80, 24);
    // Bright red text via SGR 91, written by the shell itself.
    let cmd =
        if cfg!(windows) { "powershell -NoProfile -Command \"Write-Host -ForegroundColor Red red-text\"" } else { "printf '\\033[91mred-text\\033[0m\\n'" };
    run(&t, cmd);
    let s = wait_for(&t, "the red text", |s| has_line(s, "red-text"));
    let row = (0..s.rows).find(|&r| s.line(r).trim() == "red-text").unwrap();
    let col = s.line(row).find("red-text").unwrap();
    let p = oxide_terminal::Palette::default();
    let fg = s.cell(row, col).fg;
    assert!(fg == p.ansi[9] || fg == p.ansi[1], "red-ish, got {fg:?}");
    t.kill();
}

#[test]
fn killing_ends_the_shell_and_what_it_runs() {
    let (t, _) = spawn(shell(), 80, 24);
    run(&t, if cfg!(windows) { "ping -n 60 127.0.0.1" } else { "sleep 60" });
    std::thread::sleep(Duration::from_millis(800));
    let started = Instant::now();
    t.kill();
    assert!(t.wait(Duration::from_secs(10)).is_some(), "the shell should end");
    assert!(started.elapsed() < Duration::from_secs(8));
}

#[test]
fn starting_in_the_given_folder_and_environment() {
    let dir = tempfile::tempdir().unwrap();
    let mut cmd = shell();
    cmd.cwd = Some(dir.path().to_owned());
    cmd.env.push(("OXIS_TEST_VAR".into(), "from-oxis".into()));
    let (t, _) = spawn(cmd, 120, 24);
    run(&t, if cfg!(windows) { "echo %OXIS_TEST_VAR%" } else { "echo $OXIS_TEST_VAR" });
    wait_for(&t, "the variable", |s| has_line(s, "from-oxis"));
    run(&t, if cfg!(windows) { "cd" } else { "pwd -P" });
    // Compared as folders, not text: Windows may print a short (8.3) name.
    let want = dir.path().canonicalize().unwrap();
    wait_for(&t, "the folder", |s| (0..s.rows).any(|r| std::path::Path::new(s.line(r).trim()).canonicalize().is_ok_and(|p| p == want)));
    t.kill();
}

#[test]
fn failures_to_start_say_why() {
    let missing = TerminalCommand { program: "definitely-not-a-program-xyz".into(), ..Default::default() };
    assert!(matches!(Terminal::spawn(missing, 80, 24, |_| {}), Err(SpawnError::Start { .. })));
    let mut gone = shell();
    gone.cwd = Some(PathBuf::from("/definitely/not/a/folder"));
    assert!(matches!(Terminal::spawn(gone, 80, 24, |_| {}), Err(SpawnError::NotAFolder(_))));
}

#[cfg(unix)]
#[test]
fn full_screen_programs_and_bracketed_paste() {
    let (t, _) = spawn(shell(), 80, 24);
    run(&t, "printf '\\033[?1049h\\033[?2004h\\033[?1h'; sleep 30");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !t.alt_screen() {
        assert!(Instant::now() < deadline, "the alternate screen never showed");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(t.app_cursor());
    t.kill();
}

#[cfg(unix)]
#[test]
fn unicode_and_wide_characters() {
    let (t, _) = spawn(shell(), 80, 24);
    run(&t, "printf 'h\\303\\251llo \\342\\234\\223 \\346\\274\\242\\345\\255\\227\\n'");
    let s = wait_for(&t, "the text", |s| has_line(s, "héllo ✓ 漢字"));
    let row = (0..s.rows).find(|&r| s.line(r) == "héllo ✓ 漢字").unwrap();
    assert!(s.cell(row, 8).flags.has(oxide_terminal::CellFlags::WIDE));
    assert!(s.cell(row, 9).flags.has(oxide_terminal::CellFlags::SPACER));
    t.kill();
}

#[test]
fn ctrl_c_interrupts_the_running_command_not_the_shell() {
    let (t, _) = spawn(shell(), 80, 24);
    run(&t, if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" });
    std::thread::sleep(Duration::from_millis(1500));
    t.write(&oxide_terminal::keys::encode_char('c', oxide_terminal::keys::Mods::CTRL));
    run(&t, if cfg!(windows) { "set /a 300+33" } else { "echo $((300+33))" });
    let started = Instant::now();
    wait_for(&t, "the next command's output", |s| has_line(s, "333"));
    assert!(started.elapsed() < Duration::from_secs(10), "the long command was interrupted");
    assert_eq!(t.exit_status(), None, "the shell itself keeps running");
    t.kill();
}

#[test]
fn searching_finds_text_in_the_history_and_reveals_it() {
    let (t, _) = spawn(shell(), 60, 10);
    let count = if cfg!(windows) { "for /L %i in (1,1,80) do @echo row-%i" } else { "i=1; while [ $i -le 80 ]; do echo row-$i; i=$((i+1)); done" };
    run(&t, count);
    wait_for(&t, "the last row", |s| has_line(s, "row-80"));
    run(&t, "echo Needle-In-Hay");
    wait_for(&t, "the needle", |s| has_line(s, "Needle-In-Hay"));

    // "row-1" also matches row-10…row-19 and row-1 itself: 11, plus the
    // command line that printed them.
    let rows = t.find("ROW-1");
    assert!(rows.len() >= 11, "{rows:?}");
    let first = rows.iter().find(|m| m.line < 0).copied().expect("a match in the history");
    assert_eq!(first.len, 5);
    // Ignoring case, and found where it is on screen.
    let needle = t.find("needle-in-hay");
    assert!(needle.iter().any(|m| m.line >= 0), "{needle:?}");
    assert!(t.find("not-there-at-all").is_empty());
    assert!(t.find("").is_empty());

    // Revealing a match in the history scrolls to it.
    t.reveal(first.line);
    let s = t.screen();
    assert!(s.scrolled > 0);
    let row = (first.line + s.scrolled as i32) as usize;
    assert!(row < s.rows, "the match is on screen");
    assert!(s.line(row).to_lowercase().contains("row-1"), "{}", s.text());
    t.kill();
}

#[test]
fn scrolling_and_selecting_mark_the_screen_changed() {
    let (t, _) = spawn(shell(), 40, 8);
    let count = if cfg!(windows) { "for /L %i in (1,1,40) do @echo n-%i" } else { "i=1; while [ $i -le 40 ]; do echo n-$i; i=$((i+1)); done" };
    run(&t, count);
    wait_for(&t, "the last line", |s| has_line(s, "n-40"));
    std::thread::sleep(Duration::from_millis(300));
    t.take_dirty();
    t.scroll(5);
    assert!(t.take_dirty(), "scrolling changes what's visible");
    t.select((0, 0), (0, 2));
    assert!(t.take_dirty(), "so does selecting");
    t.clear_selection();
    assert!(t.take_dirty());
    t.scroll_to_bottom();
    assert!(t.take_dirty());
    t.kill();
}
