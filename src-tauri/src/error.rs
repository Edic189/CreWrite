//! Centralized error type for the whole backend.
//!
//! Every `#[tauri::command]` returns `Result<T, AppError>`. Tauri requires the
//! error type to be `serde::Serialize` so it can be rejected back into the
//! frontend's `invoke(...)` promise. We serialize into a small tagged object
//! `{ "kind": "...", "message": "..." }` so the UI can branch on `kind`
//! (e.g. show a "pick a vault" prompt for `NoVaultOpen`) while still having a
//! human-readable `message` for toasts/logging.

use std::path::PathBuf;

use serde::{Serialize, Serializer};

/// All recoverable failures the backend can produce.
///
/// `thiserror` gives us `Display`/`std::error::Error` for free; the manual
/// `Serialize` impl below controls the wire format sent to the frontend.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// An operation was attempted before a vault was opened.
    #[error("no vault is currently open")]
    NoVaultOpen,

    /// A user-supplied relative path tried to escape the vault root
    /// (e.g. contained `..`, an absolute prefix, or a Windows drive/UNC).
    #[error("path '{0}' escapes the vault boundary")]
    PathOutsideVault(String),

    /// The path was malformed (empty, non-UTF-8, or otherwise unusable).
    #[error("invalid path: {0}")]
    InvalidPath(String),

    /// We only operate on `.md` files for note read/write commands.
    #[error("'{0}' is not a Markdown (.md) file")]
    NotMarkdown(String),

    /// A target that must exist did not, or one that must not exist already did.
    #[error("{0}")]
    NotFound(String),

    /// Underlying filesystem failure, tagged with the path we were touching.
    #[error("filesystem error at '{path}': {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// The file watcher failed to start or observe changes.
    #[error("file watcher error: {0}")]
    Watcher(String),

    /// An export (e.g. Pandoc conversion) failed.
    #[error("{0}")]
    Export(String),

    /// A shared lock was poisoned by a panic in another thread.
    #[error("internal state lock was poisoned")]
    LockPoisoned,
}

impl AppError {
    /// Build an `Io` error while remembering which path caused it.
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        AppError::Io {
            path: path.into(),
            source,
        }
    }

    /// Short, stable machine-readable discriminant for the frontend to match on.
    fn kind(&self) -> &'static str {
        match self {
            AppError::NoVaultOpen => "NoVaultOpen",
            AppError::PathOutsideVault(_) => "PathOutsideVault",
            AppError::InvalidPath(_) => "InvalidPath",
            AppError::NotMarkdown(_) => "NotMarkdown",
            AppError::NotFound(_) => "NotFound",
            AppError::Export(_) => "Export",
            AppError::Io { .. } => "Io",
            AppError::Watcher(_) => "Watcher",
            AppError::LockPoisoned => "LockPoisoned",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

/// A poisoned `RwLock`/`Mutex` collapses to a single error variant; the guard
/// is discarded because the protected state is considered untrustworthy.
impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        AppError::LockPoisoned
    }
}

/// Convenience alias used throughout the backend.
pub type AppResult<T> = Result<T, AppError>;
