//! Optional Git versioning for a vault, via libgit2 (the `git2` crate) — compiled
//! into the app, so no system `git` binary is required. Deliberately local-only:
//! init, status (changed-file count + added/removed line counts), commit-all, and
//! discard (restore the working tree to the last commit). No remotes/network.

use std::path::Path;

use git2::{DiffOptions, IndexAddOption, Repository, ResetType, Status, StatusOptions};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Snapshot of a vault's Git state for the sidebar panel.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// The vault is its own Git repository (has a `.git` directory).
    pub is_repo: bool,
    /// At least one commit exists (so "Discard" has a baseline to restore).
    pub has_head: bool,
    /// Number of files changed since the last commit (incl. untracked).
    pub files_changed: u32,
    /// Lines inserted since the last commit.
    pub added: u32,
    /// Lines deleted since the last commit.
    pub removed: u32,
}

fn git_err(e: git2::Error) -> AppError {
    AppError::Git(e.message().to_string())
}

/// Inspect the vault's Git state. Only the vault's *own* repo counts — we check
/// for `root/.git` so we don't accidentally report a parent directory's repo.
pub fn status(root: &Path) -> AppResult<GitStatus> {
    if !root.join(".git").exists() {
        return Ok(GitStatus::default()); // is_repo: false
    }
    let repo = Repository::open(root).map_err(git_err)?;
    let has_head = repo.head().is_ok();

    let mut opts = DiffOptions::new();
    // show_untracked_content makes libgit2 read new files' content so their
    // lines count as insertions (not just a changed-file entry).
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    // Diff the last commit's tree (or the empty tree, if there are no commits
    // yet) against the working directory + index = all uncommitted changes.
    let diff = match repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        Some(tree) => repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts)),
        None => repo.diff_tree_to_workdir_with_index(None, Some(&mut opts)),
    }
    .map_err(git_err)?;

    let stats = diff.stats().map_err(git_err)?;
    Ok(GitStatus {
        is_repo: true,
        has_head,
        files_changed: stats.files_changed() as u32,
        added: stats.insertions() as u32,
        removed: stats.deletions() as u32,
    })
}

/// Initialize a Git repository at the vault root (no-op if one already exists).
/// Seeds a minimal `.gitignore` so macOS `.DS_Store` files don't add noise.
pub fn init(root: &Path) -> AppResult<()> {
    Repository::init(root).map_err(git_err)?;
    let ignore = root.join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, ".DS_Store\n");
    }
    Ok(())
}

/// Stage every change (additions, modifications, and deletions) and commit it.
pub fn commit_all(root: &Path, message: &str) -> AppResult<()> {
    let repo = Repository::open(root).map_err(git_err)?;
    let mut index = repo.index().map_err(git_err)?;
    // An empty pathspec matches ALL files in libgit2 (incl. dotfiles like
    // .gitignore, which the "*" glob misses). add_all stages new/modified
    // (respecting .gitignore); update_all stages deletions of tracked files.
    let all: Vec<&str> = Vec::new();
    index
        .add_all(all.iter(), IndexAddOption::DEFAULT, None)
        .map_err(git_err)?;
    index.update_all(all.iter(), None).map_err(git_err)?;
    index.write().map_err(git_err)?;

    let tree = repo
        .find_tree(index.write_tree().map_err(git_err)?)
        .map_err(git_err)?;
    // Use the repo/global git identity if configured, else a CreWrite default.
    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("CreWrite", "crewrite@localhost"))
        .map_err(git_err)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(git_err)?;
    Ok(())
}

/// Restore the working tree to the last commit: revert modified/deleted tracked
/// files and remove files created since the commit. Destructive — the frontend
/// confirms first. Errors if there is no commit to restore to.
pub fn discard(root: &Path) -> AppResult<()> {
    let repo = Repository::open(root).map_err(git_err)?;
    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|_| AppError::Git("nothing to discard — no commit yet".into()))?;

    // Restore tracked files (revert modifications, bring back deletions).
    repo.reset(head_commit.as_object(), ResetType::Hard, None)
        .map_err(git_err)?;

    // reset --hard leaves untracked files behind, so delete files created since
    // the commit to fully match it (ignored files like .DS_Store are kept).
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(git_err)?;
    for entry in statuses.iter() {
        if entry.status().contains(Status::WT_NEW) {
            if let Some(rel) = entry.path() {
                let _ = std::fs::remove_file(root.join(rel));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "crewrite-git-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_commit_status_discard_roundtrip() {
        let root = tmp();

        // Not a repo yet.
        assert!(!status(&root).unwrap().is_repo);

        // Init + a file → status shows it as added, no HEAD yet.
        init(&root).unwrap();
        std::fs::write(root.join("note.md"), "hello\nworld\n").unwrap();
        let s = status(&root).unwrap();
        assert!(s.is_repo && !s.has_head);
        assert!(s.added >= 2 && s.files_changed >= 1);

        // Commit → clean tree, HEAD exists.
        commit_all(&root, "first").unwrap();
        let s = status(&root).unwrap();
        assert!(s.has_head);
        assert_eq!((s.files_changed, s.added, s.removed), (0, 0, 0));

        // Modify + create → changes show; discard restores the committed state.
        std::fs::write(root.join("note.md"), "hello\nworld\nmore\n").unwrap();
        std::fs::write(root.join("new.md"), "brand new\n").unwrap();
        assert!(status(&root).unwrap().files_changed >= 1);
        discard(&root).unwrap();
        let s = status(&root).unwrap();
        assert_eq!((s.files_changed, s.added, s.removed), (0, 0, 0));
        assert_eq!(std::fs::read_to_string(root.join("note.md")).unwrap(), "hello\nworld\n");
        assert!(!root.join("new.md").exists()); // untracked file removed

        let _ = std::fs::remove_dir_all(&root);
    }
}
