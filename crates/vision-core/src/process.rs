//! Running child processes: argv arrays only (never a shell string), a built environment,
//! a timeout, capped captured output, and termination of the whole process group (Unix) or
//! Job Object (Windows). Unix uses std's safe `process_group(0)` and `nix::killpg`;
//! Windows uses `process-wrap`'s Job Object wrapper.

use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::ipc::{IpcError, IpcResult};

/// A process to run headless.
#[derive(Debug, Clone)]
pub struct CommandSpec {
    /// Absolute path of the program.
    pub program: PathBuf,
    /// Arguments (never interpreted by a shell).
    pub args: Vec<OsString>,
    /// The complete environment; nothing is inherited.
    pub env: Vec<(OsString, OsString)>,
    /// Working directory.
    pub cwd: Option<PathBuf>,
    /// Time limit; the process group is killed when it is exceeded.
    pub timeout: Duration,
    /// Captured bytes per stream; the rest is read and discarded (see
    /// [`CommandOutput::truncated`]).
    pub max_output_bytes: usize,
}

/// What a finished (or killed) process produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandOutput {
    /// Exit code, `None` when killed by a signal or on timeout.
    pub exit_code: Option<i32>,
    /// Captured stdout.
    pub stdout: Vec<u8>,
    /// Captured stderr.
    pub stderr: Vec<u8>,
    /// Whether the time limit was hit.
    pub timed_out: bool,
    /// Whether either stream produced more than `max_output_bytes` (the rest was discarded).
    pub truncated: bool,
}

/// Runs processes. Implemented by [`SystemCommandRunner`] and by test fakes.
pub trait CommandRunner: Send + Sync {
    /// Runs `spec` to completion or until its timeout.
    ///
    /// # Errors
    /// `not_installed` when the program cannot be started, `io` for other spawn failures.
    fn run(&self, spec: &CommandSpec) -> IpcResult<CommandOutput>;
}

/// Pipes to attach when spawning in a group.
#[derive(Debug, Clone, Copy)]
pub struct Pipes {
    /// Pipe stdin (otherwise null).
    pub stdin: bool,
    /// Pipe stdout (otherwise null).
    pub stdout: bool,
    /// Pipe stderr (otherwise null).
    pub stderr: bool,
}

/// A child process that leads its own process group (Unix) or runs in a Job Object
/// (Windows), so [`GroupChild::kill_group`] ends it together with its descendants.
#[derive(Debug)]
pub struct GroupChild {
    #[cfg(unix)]
    child: std::process::Child,
    #[cfg(windows)]
    child: Box<dyn process_wrap::std::ChildWrapper>,
}

impl GroupChild {
    /// Spawns `program` with exactly `env` (nothing inherited).
    ///
    /// # Errors
    /// The spawn error.
    pub fn spawn(
        program: &Path,
        args: &[OsString],
        env: &[(OsString, OsString)],
        cwd: Option<&Path>,
        pipes: Pipes,
    ) -> io::Result<Self> {
        let pipe = |on: bool| if on { Stdio::piped() } else { Stdio::null() };
        let setup = |c: &mut std::process::Command| {
            c.args(args)
                .env_clear()
                .envs(env.iter().map(|(k, v)| (k, v)))
                .stdin(pipe(pipes.stdin))
                .stdout(pipe(pipes.stdout))
                .stderr(pipe(pipes.stderr));
            if let Some(d) = cwd {
                c.current_dir(d);
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let mut c = std::process::Command::new(program);
            setup(&mut c);
            c.process_group(0);
            Ok(Self { child: c.spawn()? })
        }
        #[cfg(windows)]
        {
            let mut c = process_wrap::std::CommandWrap::with_new(program, setup);
            c.wrap(process_wrap::std::JobObject);
            Ok(Self { child: c.spawn()? })
        }
    }

    /// OS process id of the group leader.
    #[must_use]
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Takes the stdin pipe.
    pub fn take_stdin(&mut self) -> Option<std::process::ChildStdin> {
        #[cfg(unix)]
        {
            self.child.stdin.take()
        }
        #[cfg(windows)]
        {
            self.child.stdin().take()
        }
    }

    /// Takes the stdout pipe.
    pub fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        #[cfg(unix)]
        {
            self.child.stdout.take()
        }
        #[cfg(windows)]
        {
            self.child.stdout().take()
        }
    }

    /// Takes the stderr pipe.
    pub fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        #[cfg(unix)]
        {
            self.child.stderr.take()
        }
        #[cfg(windows)]
        {
            self.child.stderr().take()
        }
    }

    /// Non-blocking exit check of the leader.
    ///
    /// # Errors
    /// The wait error.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Polls until the leader exits or `deadline` passes; `None` on timeout.
    ///
    /// # Errors
    /// The wait error.
    pub fn wait_until(&mut self, deadline: Instant) -> io::Result<Option<ExitStatus>> {
        let mut sleep = Duration::from_millis(1);
        loop {
            if let Some(s) = self.try_wait()? {
                return Ok(Some(s));
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            thread::sleep(sleep.min(deadline - now));
            sleep = (sleep * 2).min(Duration::from_millis(25));
        }
    }

    /// Kills every process in the group and reaps the leader. Errors (already gone) are
    /// ignored.
    pub fn kill_group(&mut self) {
        #[cfg(unix)]
        {
            if let Ok(pid) = i32::try_from(self.child.id()) {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pid),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        #[cfg(windows)]
        {
            // Terminates every process in the Job Object.
            let _ = self.child.start_kill();
            // Reap only the leader, through the wrapped child. The Job Object wrapper's own
            // `wait` blocks without a timeout on the job's completion port, and `try_wait`
            // (polled in `wait_until`) has usually consumed the port's messages by now, so
            // that `wait` never returns once the job is already empty.
            let _ = self.child.inner_mut().wait();
        }
    }
}

/// Output captured from one stream so far.
#[derive(Debug, Default)]
struct Captured {
    data: Vec<u8>,
    truncated: bool,
}

/// One stream being drained by a reader thread into a shared buffer, so the caller can take
/// whatever arrived so far even if a descendant that escaped the process group keeps the
/// pipe open.
struct Capture {
    buf: Arc<Mutex<Captured>>,
    done: mpsc::Receiver<()>,
}

impl Capture {
    fn start(mut r: impl Read + Send + 'static, cap: usize) -> Self {
        let buf = Arc::new(Mutex::new(Captured::default()));
        let (tx, done) = mpsc::channel();
        let shared = Arc::clone(&buf);
        thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match r.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Keep draining past the cap so the child never blocks on a full pipe.
                        if let Ok(mut c) = shared.lock() {
                            let room = cap.saturating_sub(c.data.len());
                            if n > room {
                                c.truncated = true;
                            }
                            c.data.extend_from_slice(&chunk[..n.min(room)]);
                        }
                    }
                }
            }
            let _ = tx.send(());
        });
        Self { buf, done }
    }

    /// Waits for end of stream until `deadline`, then returns what was captured.
    fn finish(self, deadline: Instant) -> Captured {
        let left = deadline.saturating_duration_since(Instant::now());
        let _ = self.done.recv_timeout(left);
        self.buf
            .lock()
            .map(|mut c| std::mem::take(&mut *c))
            .unwrap_or_default()
    }
}

/// How long to wait for the pipes to reach end of file after the process group was killed.
/// A descendant that left the group (a daemon started by a login shell's rc file) can keep
/// them open indefinitely; whatever arrived until then is returned.
pub const PIPE_GRACE: Duration = Duration::from_millis(250);

/// Runs real processes.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, spec: &CommandSpec) -> IpcResult<CommandOutput> {
        let pipes = Pipes {
            stdin: false,
            stdout: true,
            stderr: true,
        };
        let mut child = GroupChild::spawn(
            &spec.program,
            &spec.args,
            &spec.env,
            spec.cwd.as_deref(),
            pipes,
        )
        .map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                IpcError::new(
                    crate::ipc::ErrorCode::NotInstalled,
                    "The program was not found",
                )
            } else {
                IpcError::io(format!("Could not start the program: {e}"))
            }
        })?;
        let out = child
            .take_stdout()
            .map(|s| Capture::start(s, spec.max_output_bytes));
        let err = child
            .take_stderr()
            .map(|s| Capture::start(s, spec.max_output_bytes));
        let deadline = Instant::now() + spec.timeout;
        let status = child.wait_until(deadline);
        // Always kill the group: it ends a timed-out process and any leftover descendants.
        child.kill_group();
        let status =
            status.map_err(|e| IpcError::io(format!("Waiting for the program failed: {e}")))?;
        // One shared grace period for both streams.
        let grace = Instant::now() + PIPE_GRACE;
        let out = out.map(|c| c.finish(grace)).unwrap_or_default();
        let err = err.map(|c| c.finish(grace)).unwrap_or_default();
        Ok(CommandOutput {
            exit_code: status.and_then(|s| s.code()),
            stdout: out.data,
            stderr: err.data,
            timed_out: status.is_none(),
            truncated: out.truncated || err.truncated,
        })
    }
}
