//! Persistent app configuration (recent vaults / auto-reopen).
//!
//! Stored as `config.json` in the OS app-config directory, which Tauri resolves
//! for us via `app.path().app_config_dir()` — so no `directories`/`dirs` crate
//! is needed. This is the natural home for future settings (theme, default
//! note folder, …). Reads/writes are best-effort: a missing or malformed file
//! degrades to defaults rather than erroring.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// How many recent vaults to remember.
const MAX_RECENT: usize = 8;

/// User-facing preferences. Every field has a default so older config files (or
/// missing fields) deserialize cleanly. Serialized camelCase for the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// "dark" | "light" | "grey" | "forest" | "winter" | "sea" | "retro" | "summer".
    pub theme: String,
    /// Custom accent color (hex, e.g. "#4fa3ff); `None` = use the theme's accent.
    pub accent_color: Option<String>,
    /// Editor font size in px.
    pub editor_font_size: u8,
    /// Editor font family: "mono" | "sans" | "serif".
    pub editor_font_family: String,
    /// Editor line height (unitless multiplier, e.g. 1.7).
    pub editor_line_height: f32,
    /// Cap the editor/preview content to a readable column width.
    pub readable_line_width: bool,
    /// Column width in px used when `readable_line_width` is on.
    pub content_width: u16,
    /// Soft-wrap long lines in the editor.
    pub line_wrap: bool,
    /// Browser spellcheck in the editor.
    pub spellcheck: bool,
    /// Show line numbers in the editor gutter.
    pub line_numbers: bool,
    /// Auto-close brackets and quotes as you type.
    pub auto_pair: bool,
    /// Indent with a real tab character instead of spaces.
    pub indent_with_tabs: bool,
    /// Editor tab / indent width (spaces).
    pub tab_size: u8,
    /// View a note opens in: "edit" | "preview".
    pub default_view: String,
    /// Where new notes are created: "root" | "current" (folder).
    pub new_note_location: String,
    /// Autosave debounce in milliseconds.
    pub autosave_ms: u32,
    /// Ask for confirmation before deleting.
    pub confirm_delete: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            accent_color: None,
            editor_font_size: 15,
            editor_font_family: "mono".into(),
            editor_line_height: 1.7,
            readable_line_width: false,
            content_width: 720,
            line_wrap: true,
            spellcheck: false,
            line_numbers: false,
            auto_pair: true,
            indent_with_tabs: false,
            tab_size: 4,
            default_view: "edit".into(),
            new_note_location: "current".into(),
            autosave_ms: 600,
            confirm_delete: true,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// The vault to auto-reopen on launch.
    pub last_vault: Option<PathBuf>,
    /// Recently-opened vaults, most-recent first.
    pub recent_vaults: Vec<PathBuf>,
    /// User preferences.
    pub settings: Settings,
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("config.json"))
}

/// The on-disk location of the config file, for display in the About section.
pub fn config_path(app: &AppHandle) -> Option<String> {
    config_file(app).map(|p| p.to_string_lossy().into_owned())
}

/// Load the config, falling back to defaults if absent/unreadable/malformed.
pub fn load(app: &AppHandle) -> Config {
    let Some(path) = config_file(app) else {
        return Config::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

/// Persist the config (best-effort; failures are logged, not fatal).
fn save(app: &AppHandle, config: &Config) {
    let Some(path) = config_file(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(config) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&path, text) {
                eprintln!("[config] failed to write {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[config] failed to serialize: {e}"),
    }
}

/// Record `vault` as the most recently opened (and the auto-reopen target).
pub fn record_vault(app: &AppHandle, vault: &Path) {
    let mut config = load(app);
    config.last_vault = Some(vault.to_path_buf());
    config.recent_vaults = push_recent(std::mem::take(&mut config.recent_vaults), vault);
    save(app, &config);
}

/// Move `vault` to the front of `recents` (de-duplicated, capped at MAX_RECENT).
fn push_recent(mut recents: Vec<PathBuf>, vault: &Path) -> Vec<PathBuf> {
    recents.retain(|p| p != vault);
    recents.insert(0, vault.to_path_buf());
    recents.truncate(MAX_RECENT);
    recents
}

/// The last vault path, but only if it still exists on disk.
pub fn last_vault(app: &AppHandle) -> Option<String> {
    load(app)
        .last_vault
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Recent vaults that still exist on disk, most-recent first.
pub fn recent_vaults(app: &AppHandle) -> Vec<String> {
    load(app)
        .recent_vaults
        .into_iter()
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// The current user settings.
pub fn settings(app: &AppHandle) -> Settings {
    load(app).settings
}

/// Replace and persist the user settings.
pub fn set_settings(app: &AppHandle, settings: Settings) {
    let mut config = load(app);
    config.settings = settings;
    save(app, &config);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(items: &[&str]) -> Vec<PathBuf> {
        items.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn recents_dedupe_and_move_to_front() {
        let recents = paths(&["/a", "/b", "/c"]);
        // Re-opening /c moves it to the front without duplicating.
        let updated = push_recent(recents, Path::new("/c"));
        assert_eq!(updated, paths(&["/c", "/a", "/b"]));
    }

    #[test]
    fn recents_prepend_new() {
        let updated = push_recent(paths(&["/a"]), Path::new("/new"));
        assert_eq!(updated, paths(&["/new", "/a"]));
    }

    #[test]
    fn recents_capped_at_max() {
        let mut recents = paths(&["/0", "/1", "/2", "/3", "/4", "/5", "/6", "/7"]);
        assert_eq!(recents.len(), MAX_RECENT);
        recents = push_recent(recents, Path::new("/new"));
        assert_eq!(recents.len(), MAX_RECENT);
        assert_eq!(recents[0], PathBuf::from("/new"));
        assert!(!recents.contains(&PathBuf::from("/7"))); // oldest dropped
    }
}
