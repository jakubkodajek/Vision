//! Shared test harness: a temp data root, fake binaries, fake terminal/opener, an in-memory
//! secret store and a parent environment containing credentials that must never leak.
//! Nothing here touches the real home directory, keychain, terminal or network.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.
#![allow(dead_code)] // Each test crate uses a different subset of the harness.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use vision_core::ipc::{Accent, IpcResult, Profile, ProfileCreateArgs, ProfileKind};
use vision_core::mcp::SpecMcpProbe;
use vision_core::process::{CommandOutput, CommandRunner, CommandSpec, SystemCommandRunner};
use vision_core::secrets::MemorySecretStore;
use vision_core::terminal::{TerminalLauncher, UrlOpener};
use vision_core::{Core, CoreDeps, PathSource, Timeouts};

/// Credentials in the parent environment that must never reach a child.
pub const LEAKY: &[(&str, &str)] = &[
    ("ANTHROPIC_API_KEY", "sk-ant-leak-1111"),
    ("GH_TOKEN", "ghp_leak2222"),
    ("CLAUDE_CODE_OAUTH_TOKEN", "oauth-leak-3333"),
];

/// A launch recorded by [`FakeTerminal`].
#[derive(Debug, Clone)]
pub struct Launch {
    pub script: PathBuf,
    pub content: String,
    pub env: Vec<(OsString, OsString)>,
}

/// Records launches instead of opening a terminal.
#[derive(Debug, Default)]
pub struct FakeTerminal {
    pub launches: Mutex<Vec<Launch>>,
}

impl TerminalLauncher for FakeTerminal {
    fn launch(&self, script: &Path, env: &[(OsString, OsString)]) -> IpcResult<()> {
        let content = std::fs::read_to_string(script).unwrap_or_default();
        self.launches.lock().unwrap().push(Launch {
            script: script.to_path_buf(),
            content,
            env: env.to_vec(),
        });
        Ok(())
    }
}

/// Records URLs instead of opening a browser.
#[derive(Debug, Default)]
pub struct FakeOpener {
    pub urls: Mutex<Vec<String>>,
}

impl UrlOpener for FakeOpener {
    fn open(&self, url: &str) -> IpcResult<()> {
        self.urls.lock().unwrap().push(url.to_owned());
        Ok(())
    }
}

/// Records every command and answers exit 0 (for sync tests).
#[derive(Debug, Default)]
pub struct RecordingRunner {
    pub calls: Mutex<Vec<CommandSpec>>,
}

impl CommandRunner for RecordingRunner {
    fn run(&self, spec: &CommandSpec) -> IpcResult<CommandOutput> {
        self.calls.lock().unwrap().push(spec.clone());
        Ok(CommandOutput {
            exit_code: Some(0),
            ..CommandOutput::default()
        })
    }
}

/// One test's sandbox.
pub struct Harness {
    pub dir: tempfile::TempDir,
    pub terminal: Arc<FakeTerminal>,
    pub opener: Arc<FakeOpener>,
    pub secrets: Arc<MemorySecretStore>,
    pub runner: Arc<dyn CommandRunner>,
    pub timeouts: Timeouts,
}

impl Harness {
    /// A sandbox under the cargo target tmp dir (same file system as the fake binary, so
    /// hard links work and no file is open for writing when it is executed).
    pub fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("vision-test-")
            .tempdir_in(env!("CARGO_TARGET_TMPDIR"))
            .unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        std::fs::create_dir_all(dir.path().join("home")).unwrap();
        Self {
            dir,
            terminal: Arc::new(FakeTerminal::default()),
            opener: Arc::new(FakeOpener::default()),
            secrets: Arc::new(MemorySecretStore::new()),
            runner: Arc::new(SystemCommandRunner),
            timeouts: Timeouts {
                status: Duration::from_secs(5),
                version: Duration::from_secs(5),
                mcp_probe: Duration::from_secs(5),
                sync: Duration::from_secs(5),
            },
        }
    }

    pub fn data_root(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    pub fn bin_dir(&self) -> PathBuf {
        self.dir.path().join("bin")
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Parent environment: a fake HOME, the fake bin dir as PATH, and leaky credentials.
    pub fn parent_env(&self) -> Vec<(OsString, OsString)> {
        let mut v: Vec<(OsString, OsString)> = vec![
            ("HOME".into(), self.dir.path().join("home").into()),
            ("PATH".into(), self.bin_dir().into()),
            ("LANG".into(), "en_US.UTF-8".into()),
            ("LC_ALL".into(), "en_US.UTF-8".into()),
            ("HTTPS_PROXY".into(), "http://proxy.invalid:3128".into()),
            ("RANDOM_APP_VAR".into(), "should-not-pass".into()),
        ];
        if cfg!(windows) {
            for k in ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"] {
                if let Some(val) = std::env::var_os(k) {
                    v.push((k.into(), val));
                }
            }
        }
        for (k, val) in LEAKY {
            v.push(((*k).into(), (*val).into()));
        }
        v
    }

    pub fn deps(&self) -> CoreDeps {
        CoreDeps {
            runner: Arc::clone(&self.runner),
            terminal: self.terminal.clone(),
            opener: self.opener.clone(),
            secrets: self.secrets.clone(),
            probe: Arc::new(SpecMcpProbe),
            parent_env: self.parent_env(),
            path: PathSource::Fixed(self.bin_dir().into()),
            timeouts: self.timeouts,
        }
    }

    pub fn core(&self) -> Core {
        Core::open(self.data_root(), self.deps()).unwrap()
    }

    /// Installs the fake binary as `name` with the given behaviour.
    pub fn install_fake(&self, name: &str, cfg: Value) -> PathBuf {
        install_fake_in(&self.bin_dir(), name, &cfg)
    }

    pub fn launches(&self) -> Vec<Launch> {
        self.terminal.launches.lock().unwrap().clone()
    }
}

/// Hard-links (or copies) the fake binary into `dir` as `name` and writes its config.
pub fn install_fake_in(dir: &Path, name: &str, cfg: &Value) -> PathBuf {
    let src = PathBuf::from(env!("CARGO_BIN_EXE_vision-test-fake"));
    let dest = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    if std::fs::hard_link(&src, &dest).is_err() {
        std::fs::copy(&src, &dest).unwrap();
    }
    std::fs::write(dir.join(format!("{name}.fake.json")), cfg.to_string()).unwrap();
    dest
}

pub fn create_profile(core: &Core, name: &str) -> Profile {
    core.profile_create(ProfileCreateArgs {
        name: name.to_owned(),
        kind: ProfileKind::Work,
        accent: Accent::Iris,
    })
    .unwrap()
}

/// Reads a file written by the fake's `dump_env`.
pub fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

pub fn assert_no_leaks(text: &str) {
    for (k, v) in LEAKY {
        assert!(!text.contains(k), "{k} leaked");
        assert!(!text.contains(v), "value of {k} leaked");
    }
    assert!(
        !text.contains("RANDOM_APP_VAR"),
        "non-allowlisted variable leaked"
    );
}
