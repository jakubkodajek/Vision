//! Secret values of MCP servers (spec §2.5). Values live only in the OS credential store;
//! [`SecretString`] has no `Serialize` and a redacted `Debug`.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;

use crate::ipc::{ErrorCode, IpcError, IpcResult};

/// Credential-store service name.
pub const SECRET_SERVICE: &str = "io.github.jakubkodajek.vision";

/// A secret value. Deliberately not `Serialize`, not `Display`; `Debug` is redacted.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    /// Wraps a value.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrows the value. Only call this at the point of use (process env, HTTP header).
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

/// Which list of a server an entry belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretScope {
    /// stdio env variable.
    Env,
    /// http header.
    Header,
}

/// Credential-store account: `mcp/<profile-id>/<server-id>/<env|header>/<key>`.
#[must_use]
pub fn secret_account(profile_id: &str, server_id: &str, scope: SecretScope, key: &str) -> String {
    let s = match scope {
        SecretScope::Env => "env",
        SecretScope::Header => "header",
    };
    format!("mcp/{profile_id}/{server_id}/{s}/{key}")
}

/// OS credential store abstraction.
pub trait SecretStore: Send + Sync {
    /// Stores or replaces a value.
    ///
    /// # Errors
    /// `secret_store_unavailable` when no store is available.
    fn set(&self, account: &str, value: &SecretString) -> IpcResult<()>;
    /// Reads a value; `None` when absent.
    ///
    /// # Errors
    /// `secret_store_unavailable` when no store is available.
    fn get(&self, account: &str) -> IpcResult<Option<SecretString>>;
    /// Deletes a value; deleting a missing value succeeds.
    ///
    /// # Errors
    /// `secret_store_unavailable` when no store is available.
    fn delete(&self, account: &str) -> IpcResult<()>;
}

fn unavailable() -> IpcError {
    IpcError::new(
        ErrorCode::SecretStoreUnavailable,
        "The system credential store is not available, so the secret was not saved",
    )
}

/// The OS credential store (Keychain, Windows Credential Manager, Secret Service).
#[derive(Debug, Default, Clone, Copy)]
pub struct OsSecretStore;

impl OsSecretStore {
    fn entry(account: &str) -> IpcResult<keyring::Entry> {
        keyring::Entry::new(SECRET_SERVICE, account).map_err(|e| map_keyring(&e))
    }
}

fn map_keyring(e: &keyring::Error) -> IpcError {
    match e {
        keyring::Error::NoStorageAccess(_)
        | keyring::Error::NoDefaultStore
        | keyring::Error::PlatformFailure(_)
        | keyring::Error::NotSupportedByStore(_) => unavailable(),
        // Never include the error text: some variants carry the stored bytes.
        _ => IpcError::internal("The credential store returned an unexpected error"),
    }
}

impl SecretStore for OsSecretStore {
    fn set(&self, account: &str, value: &SecretString) -> IpcResult<()> {
        Self::entry(account)?
            .set_password(value.expose())
            .map_err(|e| map_keyring(&e))
    }

    fn get(&self, account: &str) -> IpcResult<Option<SecretString>> {
        match Self::entry(account)?.get_password() {
            Ok(v) => Ok(Some(SecretString(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_keyring(&e)),
        }
    }

    fn delete(&self, account: &str) -> IpcResult<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_keyring(&e)),
        }
    }
}

/// In-memory store for tests and development. Can simulate an unavailable store.
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    map: Mutex<BTreeMap<String, String>>,
    unavailable: AtomicBool,
}

impl MemorySecretStore {
    /// An empty, available store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Makes every later call fail with `secret_store_unavailable` (or succeed again).
    pub fn set_unavailable(&self, unavailable: bool) {
        self.unavailable.store(unavailable, Ordering::SeqCst);
    }

    /// Accounts currently stored, sorted.
    #[must_use]
    pub fn accounts(&self) -> Vec<String> {
        self.map
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn check(&self) -> IpcResult<()> {
        if self.unavailable.load(Ordering::SeqCst) {
            Err(unavailable())
        } else {
            Ok(())
        }
    }

    fn lock(&self) -> IpcResult<std::sync::MutexGuard<'_, BTreeMap<String, String>>> {
        self.map
            .lock()
            .map_err(|_| IpcError::internal("Secret store lock poisoned"))
    }
}

impl SecretStore for MemorySecretStore {
    fn set(&self, account: &str, value: &SecretString) -> IpcResult<()> {
        self.check()?;
        self.lock()?.insert(account.to_owned(), value.0.clone());
        Ok(())
    }

    fn get(&self, account: &str) -> IpcResult<Option<SecretString>> {
        self.check()?;
        Ok(self.lock()?.get(account).cloned().map(SecretString))
    }

    fn delete(&self, account: &str) -> IpcResult<()> {
        self.check()?;
        self.lock()?.remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let s = SecretString::new("hunter2");
        assert!(!format!("{s:?}").contains("hunter2"));
    }

    #[test]
    fn memory_store_round_trips_and_simulates_unavailability() {
        let store = MemorySecretStore::new();
        store.set("a", &SecretString::new("v")).unwrap();
        assert_eq!(store.get("a").unwrap().unwrap().expose(), "v");
        store.delete("a").unwrap();
        assert!(store.get("a").unwrap().is_none());
        store.set_unavailable(true);
        assert_eq!(
            store.set("a", &SecretString::new("v")).unwrap_err().code,
            ErrorCode::SecretStoreUnavailable
        );
    }

    #[test]
    fn account_format_matches_spec() {
        assert_eq!(
            secret_account("p_x", "m_y", SecretScope::Header, "Authorization"),
            "mcp/p_x/m_y/header/Authorization"
        );
    }
}
