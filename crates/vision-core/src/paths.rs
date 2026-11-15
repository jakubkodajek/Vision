//! Data root layout (spec §2.1). No path is ever built from a display name: only from
//! validated profile and tool ids.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::ids;
use crate::ipc::{IpcError, IpcResult};

/// The data root and the paths derived from it.
#[derive(Debug, Clone)]
pub struct DataRoot {
    root: PathBuf,
}

impl DataRoot {
    /// Wraps an absolute data-root path.
    ///
    /// # Errors
    /// Returns `invalid_input` if `root` is relative.
    pub fn new(root: impl Into<PathBuf>) -> IpcResult<Self> {
        let root = root.into();
        if !root.is_absolute() {
            return Err(IpcError::invalid_input(
                "The data directory must be an absolute path",
            ));
        }
        Ok(Self { root })
    }

    /// The root directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `app.db`.
    #[must_use]
    pub fn app_db(&self) -> PathBuf {
        self.root.join("app.db")
    }

    /// `backups/`.
    #[must_use]
    pub fn backups(&self) -> PathBuf {
        self.root.join("backups")
    }

    /// `tmp/` (launch scripts, cleared on start).
    #[must_use]
    pub fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /// `profiles/`.
    #[must_use]
    pub fn profiles(&self) -> PathBuf {
        self.root.join("profiles")
    }

    /// `profiles/<id>/`. The id must already be validated.
    ///
    /// # Errors
    /// Returns `invalid_input` for an invalid id.
    pub fn profile_dir(&self, profile_id: &str) -> IpcResult<PathBuf> {
        ids::validate_profile_id(profile_id)?;
        Ok(self.profiles().join(profile_id))
    }

    /// `profiles/<id>/profile.db`.
    ///
    /// # Errors
    /// Returns `invalid_input` for an invalid id.
    pub fn profile_db(&self, profile_id: &str) -> IpcResult<PathBuf> {
        Ok(self.profile_dir(profile_id)?.join("profile.db"))
    }

    /// `profiles/<id>/tools/<tool-id>/`.
    ///
    /// # Errors
    /// Returns `invalid_input` for an invalid profile or tool id.
    pub fn tool_dir(&self, profile_id: &str, tool_id: &str) -> IpcResult<PathBuf> {
        ids::validate_tool_id(tool_id)?;
        Ok(self.profile_dir(profile_id)?.join("tools").join(tool_id))
    }
}

/// Creates `path` (and parents) and restricts it to the current user (0700 on Unix).
///
/// # Errors
/// Returns the underlying I/O error.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes `contents` to a new file readable and executable only by the user (0700 on Unix).
///
/// # Errors
/// Returns the underlying I/O error.
pub fn write_private_executable(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o700);
    }
    let mut f = opts.open(path)?;
    f.write_all(contents)?;
    f.sync_all()
}
