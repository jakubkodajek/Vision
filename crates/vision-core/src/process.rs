//! Running child processes: argv arrays only (never a shell string), a built environment,
//! a timeout, capped captured output, and termination of the whole process group (Unix) or
//! Job Object (Windows). Unix uses std's safe `process_group(0)` and `nix::killpg`;
//! Windows uses `process-wrap`'s Job Object wrapper.

use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::mpsc;
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
    /// Captured bytes per stream; the rest is read and discarded.
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
            let _ = self.child.start_kill();
            let _ = self.child.wait();
        }
    }
}

fn capture(mut r: impl Read + Send + 'static, cap: usize) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(kept.len());
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
        let _ = tx.send(kept);
    });
    rx
}

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
        let out_rx = child
            .take_stdout()
            .map(|s| capture(s, spec.max_output_bytes));
        let err_rx = child
            .take_stderr()
            .map(|s| capture(s, spec.max_output_bytes));
        let deadline = Instant::now() + spec.timeout;
        let status = child.wait_until(deadline);
        // Always kill the group: it ends a timed-out process and any leftover descendants.
        child.kill_group();
        let status =
            status.map_err(|e| IpcError::io(format!("Waiting for the program failed: {e}")))?;
        // Pipes close once the group is dead; a short grace period guards against
        // descendants that escaped the group and still hold them.
        let collect = |rx: Option<mpsc::Receiver<Vec<u8>>>| {
            rx.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok())
                .unwrap_or_default()
        };
        Ok(CommandOutput {
            exit_code: status.and_then(|s| s.code()),
            stdout: collect(out_rx),
            stderr: collect(err_rx),
            timed_out: status.is_none(),
        })
    }
}
