//! Thread-safe application state managed by Tauri.
//!
//! Tauri invokes commands on a worker thread pool, so any shared mutable state
//! must be `Send + Sync`. We wrap the vault session in an `RwLock`: reads
//! (every note open, render, tree/index query) vastly outnumber writes (opening
//! a vault, rebuilding the index), and `RwLock` lets concurrent reads proceed
//! without contention.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use notify::RecommendedWatcher;

use crate::error::{AppError, AppResult};
use crate::index::{self, VaultIndex};

/// The currently-open vault, if any.
#[derive(Default)]
pub struct VaultSession {
    /// Absolute, canonicalized path to the vault root.
    root: Option<PathBuf>,
    /// Cached link/tag index for the vault.
    index: VaultIndex,
    /// Live filesystem watcher. Held here so it lives as long as the session;
    /// dropping it (on vault switch/close) automatically stops watching.
    _watcher: Option<RecommendedWatcher>,
}

impl VaultSession {
    /// The current vault root, or `NoVaultOpen` if none is open.
    pub fn root(&self) -> AppResult<PathBuf> {
        self.root.clone().ok_or(AppError::NoVaultOpen)
    }

    /// Replace the active vault, swapping in its watcher and index. The previous
    /// watcher (if any) is dropped here, ending the old subscription.
    pub fn set(&mut self, root: PathBuf, watcher: RecommendedWatcher, index: VaultIndex) {
        self.root = Some(root);
        self._watcher = Some(watcher);
        self.index = index;
    }
}

/// Tauri-managed wrapper. Access via `tauri::State<AppState>` in commands.
#[derive(Default)]
pub struct AppState {
    session: RwLock<VaultSession>,
}

impl AppState {
    /// Run `f` with the current root, propagating `NoVaultOpen` if closed.
    /// Keeps the read lock held only for the duration of `f`.
    pub fn with_root<T>(&self, f: impl FnOnce(&Path) -> AppResult<T>) -> AppResult<T> {
        let guard = self.session.read()?;
        let root = guard.root()?;
        f(&root)
    }

    /// Run `f` with the cached index, propagating `NoVaultOpen` if closed.
    pub fn with_index<T>(&self, f: impl FnOnce(&VaultIndex) -> AppResult<T>) -> AppResult<T> {
        let guard = self.session.read()?;
        guard.root()?; // ensure a vault is actually open
        f(&guard.index)
    }

    /// Open a new vault, installing its watcher and index under the write lock.
    pub fn open(
        &self,
        root: PathBuf,
        watcher: RecommendedWatcher,
        index: VaultIndex,
    ) -> AppResult<()> {
        let mut guard = self.session.write()?;
        guard.set(root, watcher, index);
        Ok(())
    }

    /// Rebuild the cached index from disk.
    ///
    /// The expensive scan runs *without* the lock held (only a brief read lock
    /// to snapshot the root, then a brief write lock to store the result). If
    /// the vault changed underneath us mid-scan, the result is discarded.
    pub fn refresh_index(&self) -> AppResult<()> {
        let root = {
            let guard = self.session.read()?;
            guard.root()?
        };
        let index = index::build(&root)?;
        let mut guard = self.session.write()?;
        if guard.root.as_deref() == Some(root.as_path()) {
            guard.index = index;
        }
        Ok(())
    }
}
