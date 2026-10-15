//! The process engine: real operating-system processes, started, watched,
//! fed input, cancelled and cleaned up.
//!
//! Each process gets its own reader threads (stdout, stderr) and a waiter
//! thread, so nothing here blocks the caller. Output is published line by
//! line as [`Event::ProcessOutput`]; [`Event::ProcessExited`] always comes
//! after the last line. Cancelling stops the whole process tree — on
//! Windows through a job object, on Unix through a process group — so a
//! cancelled `npm run dev` doesn't leave its node server behind.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::events::{Event, EventBus, Stream};
use crate::ids::{ProcessId, WorkspaceId};

/// What to run.
#[derive(Clone, Debug, Default)]
pub struct ProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Variables added to (or replacing) the inherited environment.
    pub env: Vec<(String, String)>,
    /// The workspace that owns it; closing that workspace stops it.
    pub owner: Option<WorkspaceId>,
}

impl ProcessSpec {
    pub fn new(program: impl Into<String>) -> Self {
        Self { program: program.into(), ..Self::default() }
    }
    pub fn arg(mut self, a: impl Into<String>) -> Self {
        self.args.push(a.into());
        self
    }
    pub fn args<I: IntoIterator<Item = S>, S: Into<String>>(mut self, args: I) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }
    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
    pub fn owner(mut self, ws: WorkspaceId) -> Self {
        self.owner = Some(ws);
        self
    }

    /// The command line, for display.
    pub fn display(&self) -> String {
        std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.to_owned() })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Running,
    /// `code` is None when the process was killed by a signal or its code
    /// couldn't be read; `cancelled` means OXIS stopped it.
    Exited {
        code: Option<i32>,
        cancelled: bool,
    },
}

impl Status {
    /// True only for a process that ended by itself with exit code 0.
    pub fn succeeded(self) -> bool {
        matches!(self, Status::Exited { code: Some(0), cancelled: false })
    }
}

#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub id: ProcessId,
    pub command: String,
    pub owner: Option<WorkspaceId>,
    pub status: Status,
}

struct Entry {
    command: String,
    owner: Option<WorkspaceId>,
    status: Mutex<Status>,
    exited: Condvar,
    cancelled: AtomicBool,
    stdin: Mutex<Option<ChildStdin>>,
    tree: platform::Tree,
}

/// Starts and manages processes. Cheap to clone.
#[derive(Clone)]
pub struct ProcessEngine {
    bus: EventBus,
    procs: Arc<Mutex<HashMap<ProcessId, Arc<Entry>>>>,
    keep_exited: usize,
}

impl ProcessEngine {
    pub fn new(bus: EventBus) -> Self {
        Self { bus, procs: Arc::default(), keep_exited: KEEP_EXITED }
    }

    /// How many ended processes to remember (at least one).
    pub fn set_keep_exited(&mut self, n: usize) {
        self.keep_exited = n.max(1);
    }

    pub fn spawn(&self, spec: ProcessSpec) -> Result<ProcessId> {
        // Checked here because the OS blames the program, not the folder.
        if let Some(dir) = &spec.cwd {
            if !dir.is_dir() {
                return Err(Error::NotAFolder(dir.clone()));
            }
        }
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = &spec.cwd {
            cmd.current_dir(dir);
        }
        cmd.envs(spec.env.iter().map(|(k, v)| (k, v)));
        platform::prepare(&mut cmd);

        let mut child = cmd.spawn().map_err(|source| Error::Spawn { program: spec.program.clone(), source })?;
        let tree = platform::Tree::attach(&child);
        let id = ProcessId::next();
        let entry = Arc::new(Entry {
            command: spec.display(),
            owner: spec.owner,
            status: Mutex::new(Status::Running),
            exited: Condvar::new(),
            cancelled: AtomicBool::new(false),
            stdin: Mutex::new(child.stdin.take()),
            tree,
        });
        {
            let mut procs = self.procs.lock().unwrap();
            forget_oldest_exited(&mut procs, self.keep_exited);
            procs.insert(id, entry.clone());
        }
        self.bus.publish(Event::ProcessStarted { id, owner: spec.owner, command: entry.command.clone() });
        tracing::debug!(%id, command = %entry.command, "process started");

        let readers: Vec<_> = [
            child.stdout.take().map(|r| (Box::new(r) as Box<dyn Read + Send>, Stream::Stdout)),
            child.stderr.take().map(|r| (Box::new(r) as Box<dyn Read + Send>, Stream::Stderr)),
        ]
        .into_iter()
        .flatten()
        .map(|(r, stream)| {
            let bus = self.bus.clone();
            let (done_tx, done_rx) = crossbeam_channel::bounded::<()>(1);
            thread::Builder::new()
                .name(format!("{id}-{stream:?}"))
                .spawn(move || {
                    read_lines(r, |line| bus.publish(Event::ProcessOutput { id, stream, line }));
                    let _ = done_tx.send(());
                })
                .expect("couldn't start a reader thread");
            done_rx
        })
        .collect();

        let bus = self.bus.clone();
        thread::Builder::new()
            .name(format!("{id}-wait"))
            .spawn(move || {
                let code = child.wait().ok().and_then(|s| s.code());
                // All output is delivered before the exit is announced. But
                // after a cancel, something that escaped the kill (a daemon
                // in its own session) may hold the pipes open for ever, so
                // then the wait for the last output is bounded.
                let bound = Instant::now() + READER_GRACE;
                for done in readers {
                    if entry.cancelled.load(Ordering::SeqCst) {
                        let _ = done.recv_deadline(bound);
                    } else {
                        let _ = done.recv();
                    }
                }
                let cancelled = entry.cancelled.load(Ordering::SeqCst);
                let status = Status::Exited { code, cancelled };
                *entry.status.lock().unwrap() = status;
                entry.stdin.lock().unwrap().take();
                entry.exited.notify_all();
                tracing::debug!(%id, ?code, cancelled, "process exited");
                bus.publish(Event::ProcessExited { id, code, cancelled });
            })
            .expect("couldn't start a waiter thread");
        Ok(id)
    }

    /// Sends bytes to the process's standard input.
    pub fn write_input(&self, id: ProcessId, bytes: &[u8]) -> Result<()> {
        let entry = self.entry(id)?;
        let mut stdin = entry.stdin.lock().unwrap();
        let pipe = stdin.as_mut().ok_or(Error::NoProcess(id))?;
        pipe.write_all(bytes).and_then(|_| pipe.flush()).map_err(|e| Error::io("couldn't write to", entry.command.clone(), e))
    }

    /// Closes the process's standard input (end of file).
    pub fn close_input(&self, id: ProcessId) -> Result<()> {
        self.entry(id)?.stdin.lock().unwrap().take();
        Ok(())
    }

    /// Stops the process and everything it started. Does nothing to a
    /// process that has already ended.
    pub fn cancel(&self, id: ProcessId) -> Result<()> {
        let entry = self.entry(id)?;
        if *entry.status.lock().unwrap() == Status::Running {
            entry.cancelled.store(true, Ordering::SeqCst);
            entry.tree.kill();
        }
        Ok(())
    }

    /// Stops every running process the workspace owns; returns how many.
    pub fn cancel_owned_by(&self, ws: WorkspaceId) -> usize {
        let owned: Vec<ProcessId> =
            self.procs.lock().unwrap().iter().filter(|(_, e)| e.owner == Some(ws) && *e.status.lock().unwrap() == Status::Running).map(|(id, _)| *id).collect();
        for id in &owned {
            let _ = self.cancel(*id);
        }
        owned.len()
    }

    pub fn status(&self, id: ProcessId) -> Result<Status> {
        Ok(*self.entry(id)?.status.lock().unwrap())
    }

    /// Waits for the process to end, up to `timeout`; returns its status
    /// either way.
    pub fn wait(&self, id: ProcessId, timeout: Duration) -> Result<Status> {
        let entry = self.entry(id)?;
        let deadline = Instant::now() + timeout;
        let mut status = entry.status.lock().unwrap();
        while *status == Status::Running {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            status = entry.exited.wait_timeout(status, left).unwrap().0;
        }
        Ok(*status)
    }

    pub fn list(&self) -> Vec<ProcessInfo> {
        let mut v: Vec<_> = self
            .procs
            .lock()
            .unwrap()
            .iter()
            .map(|(id, e)| ProcessInfo { id: *id, command: e.command.clone(), owner: e.owner, status: *e.status.lock().unwrap() })
            .collect();
        v.sort_by_key(|p| p.id);
        v
    }

    /// Forgets processes that have ended (their history stays in events).
    pub fn prune(&self) {
        self.procs.lock().unwrap().retain(|_, e| *e.status.lock().unwrap() == Status::Running);
    }

    fn entry(&self, id: ProcessId) -> Result<Arc<Entry>> {
        self.procs.lock().unwrap().get(&id).cloned().ok_or(Error::NoProcess(id))
    }
}

/// How long, after a cancel, to wait for a process's last output.
const READER_GRACE: Duration = Duration::from_secs(2);

/// How many ended processes the engine remembers by default (for
/// `status`, `wait` and `list`); older ones are forgotten as new ones
/// start, so a long session doesn't grow without bound. Running processes
/// are never forgotten.
pub const KEEP_EXITED: usize = 256;

/// Makes room for one more: leaves at most `keep - 1` ended processes.
fn forget_oldest_exited(procs: &mut HashMap<ProcessId, Arc<Entry>>, keep: usize) {
    let mut exited: Vec<ProcessId> = procs.iter().filter(|(_, e)| *e.status.lock().unwrap() != Status::Running).map(|(id, _)| *id).collect();
    if exited.len() < keep {
        return;
    }
    exited.sort();
    for id in &exited[..exited.len() + 1 - keep] {
        procs.remove(id);
    }
}

/// Reads `r` line by line (any encoding: invalid UTF-8 is replaced), without
/// line endings; a last line with no newline is still delivered.
fn read_lines(r: Box<dyn Read + Send>, mut emit: impl FnMut(String)) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                emit(String::from_utf8_lossy(&buf).into_owned());
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// No console window flashes up for a background process.
    pub fn prepare(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    /// A job object holding the process and everything it starts; killing
    /// the job kills the tree, and so does closing OXIS (KILL_ON_JOB_CLOSE).
    pub struct Tree {
        job: HANDLE,
        fallback_pid: u32,
    }

    // The job handle is only used through thread-safe Win32 calls.
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}

    impl Tree {
        pub fn attach(child: &Child) -> Self {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if !job.is_null() {
                    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        &info as *const _ as *const _,
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    );
                    if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                        CloseHandle(job);
                        return Self { job: std::ptr::null_mut(), fallback_pid: child.id() };
                    }
                }
                Self { job, fallback_pid: child.id() }
            }
        }

        pub fn kill(&self) {
            unsafe {
                if !self.job.is_null() && TerminateJobObject(self.job, 1) != 0 {
                    return;
                }
            }
            // No job (or it failed): stop at least the process itself.
            let _ = std::process::Command::new("taskkill").args(["/PID", &self.fallback_pid.to_string(), "/T", "/F"]).creation_flags(CREATE_NO_WINDOW).output();
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            if !self.job.is_null() {
                unsafe { CloseHandle(self.job) };
            }
        }
    }
}

#[cfg(unix)]
mod platform {
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    /// The process leads its own process group, so the whole tree can be
    /// signalled at once.
    pub fn prepare(cmd: &mut Command) {
        cmd.process_group(0);
    }

    pub struct Tree {
        pgid: i32,
    }

    impl Tree {
        pub fn attach(child: &Child) -> Self {
            Self { pgid: child.id() as i32 }
        }

        pub fn kill(&self) {
            unsafe {
                if libc::kill(-self.pgid, libc::SIGKILL) != 0 {
                    libc::kill(self.pgid, libc::SIGKILL);
                }
            }
        }
    }
}
