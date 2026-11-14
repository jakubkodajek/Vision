//! Per-profile lifecycle gate (BUG-10): every profile-scoped operation enters the profile's
//! gate for its whole duration; `profile_delete` closes the gate, waits until the operations
//! in flight have left, deletes, and leaves a tombstone so operations that start afterwards
//! fail with `not_found` instead of recreating files of a profile that no longer exists.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};

use crate::ipc::{IpcError, IpcResult};

#[derive(Debug, Default)]
struct State {
    /// Operations currently inside.
    active: usize,
    /// A delete is waiting or running.
    closing: bool,
    /// The profile was deleted.
    deleted: bool,
}

/// The gates of every profile.
#[derive(Debug, Default)]
pub struct Gates {
    map: Mutex<HashMap<String, State>>,
    changed: Condvar,
}

/// Proof that an operation is inside a profile's gate; leaving happens on drop.
#[derive(Debug)]
#[must_use = "the gate is left when the guard is dropped"]
pub struct Entered<'a> {
    gates: &'a Gates,
    id: String,
}

impl Drop for Entered<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.gates.map.lock() {
            if let Some(s) = map.get_mut(&self.id) {
                s.active = s.active.saturating_sub(1);
            }
            self.gates.changed.notify_all();
        }
    }
}

fn gone() -> IpcError {
    IpcError::not_found("Profile not found")
}

impl Gates {
    fn lock(&self) -> IpcResult<MutexGuard<'_, HashMap<String, State>>> {
        self.map
            .lock()
            .map_err(|_| IpcError::internal("Profile lock poisoned"))
    }

    fn wait<'a>(
        &self,
        guard: MutexGuard<'a, HashMap<String, State>>,
    ) -> IpcResult<MutexGuard<'a, HashMap<String, State>>> {
        self.changed
            .wait(guard)
            .map_err(|_| IpcError::internal("Profile lock poisoned"))
    }

    /// Enters the gate of `id`, waiting while a delete is in progress.
    ///
    /// # Errors
    /// `not_found` when the profile was deleted.
    pub fn enter(&self, id: &str) -> IpcResult<Entered<'_>> {
        let mut map = self.lock()?;
        loop {
            let s = map.entry(id.to_owned()).or_default();
            if s.deleted {
                return Err(gone());
            }
            if !s.closing {
                s.active += 1;
                return Ok(Entered {
                    gates: self,
                    id: id.to_owned(),
                });
            }
            map = self.wait(map)?;
        }
    }

    /// Closes the gate of `id` and waits until no operation is inside. Returns `false` when
    /// the profile was already deleted (by a concurrent delete).
    ///
    /// # Errors
    /// `internal` if the lock is poisoned.
    pub fn close(&self, id: &str) -> IpcResult<bool> {
        let mut map = self.lock()?;
        loop {
            let s = map.entry(id.to_owned()).or_default();
            if s.deleted {
                return Ok(false);
            }
            if !s.closing {
                s.closing = true;
                break;
            }
            map = self.wait(map)?;
        }
        while map.get(id).is_some_and(|s| s.active > 0) {
            map = self.wait(map)?;
        }
        Ok(true)
    }

    /// Reopens the gate after [`Gates::close`]; `deleted` leaves a tombstone.
    pub fn reopen(&self, id: &str, deleted: bool) {
        if let Ok(mut map) = self.map.lock() {
            let s = map.entry(id.to_owned()).or_default();
            s.closing = false;
            s.deleted = deleted;
            self.changed.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entering_a_deleted_profile_is_not_found() {
        let g = Gates::default();
        assert!(g.close("p").unwrap());
        g.reopen("p", true);
        assert_eq!(
            g.enter("p").unwrap_err().code,
            crate::ipc::ErrorCode::NotFound
        );
    }

    #[test]
    fn close_waits_for_operations_inside() {
        let g = std::sync::Arc::new(Gates::default());
        let inside = g.enter("p").unwrap();
        let g2 = std::sync::Arc::clone(&g);
        let t = std::thread::spawn(move || g2.close("p").unwrap());
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!t.is_finished());
        drop(inside);
        assert!(t.join().unwrap());
    }
}
