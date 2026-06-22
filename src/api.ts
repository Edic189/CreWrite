// Thin, fully-typed wrappers around the Tauri command bridge.
// Every backend command is exposed here so the rest of the UI never touches
// raw `invoke()` strings — rename a command once, fix it once.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppInfo,
  ChangeEvent,
  FileNode,
  GitStatus,
  GraphData,
  NoteRef,
  RenderedNote,
  Settings,
  TagCount,
  VaultInfo,
} from "./types";

/** Open the native folder picker and load the chosen vault. */
export function selectVault(): Promise<VaultInfo | null> {
  return invoke<VaultInfo | null>("select_vault");
}

/** Open a vault at an explicit path (e.g. restoring a recent vault). */
export function openVault(path: string): Promise<VaultInfo> {
  return invoke<VaultInfo>("open_vault", { path });
}

/** The last-opened vault path (to auto-reopen on launch), if it still exists. */
export function getLastVault(): Promise<string | null> {
  return invoke<string | null>("get_last_vault");
}

/** Recently-opened vaults that still exist, most-recent first. */
export function getRecentVaults(): Promise<string[]> {
  return invoke<string[]>("get_recent_vaults");
}

/** Load the persisted user settings. */
export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

/** Persist updated user settings. */
export function setSettings(settings: Settings): Promise<void> {
  return invoke<void>("set_settings", { settings });
}

/** App version + config-file location, for the Settings → About section. */
export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

// --- Git (in-app vault versioning) ----------------------------------------

/** Current Git state of the vault (is-repo + change counts). */
export function gitStatus(): Promise<GitStatus> {
  return invoke<GitStatus>("git_status");
}

/** Initialize a Git repository at the vault root; returns the new status. */
export function gitInit(): Promise<GitStatus> {
  return invoke<GitStatus>("git_init");
}

/** Stage all changes and commit them; returns the resulting status. */
export function gitCommit(message: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_commit", { message });
}

/** Discard all changes since the last commit; returns the resulting status. */
export function gitDiscard(): Promise<GitStatus> {
  return invoke<GitStatus>("git_discard");
}

/** Export notes to "docx"/"pdf" (built-in); resolves to #files written, or null if cancelled.
 * `images` maps each ```mermaid block's trimmed source to its rendered PNG (base64). */
export function exportDocuments(
  scope: string,
  path: string,
  combine: boolean,
  stripFrontmatter: boolean,
  format: string,
  images: Record<string, string>,
): Promise<number | null> {
  return invoke<number | null>("export_documents", {
    scope,
    path,
    combine,
    stripFrontmatter,
    format,
    images,
  });
}

/** Trimmed source of every unique ```mermaid block in the export set. */
export function exportMermaidSources(
  scope: string,
  path: string,
  combine: boolean,
  stripFrontmatter: boolean,
): Promise<string[]> {
  return invoke<string[]>("export_mermaid_sources", { scope, path, combine, stripFrontmatter });
}

/** Re-read the current vault's file tree. */
export function readVaultTree(): Promise<FileNode> {
  return invoke<FileNode>("read_vault_tree");
}

/** Read a Markdown note's contents. */
export function readNote(path: string): Promise<string> {
  return invoke<string>("read_note", { path });
}

/** Save a Markdown note's contents (creates parent dirs as needed). */
export function writeNote(path: string, content: string): Promise<void> {
  return invoke<void>("write_note", { path, content });
}

/** Create a new empty note; resolves to the refreshed tree. */
export function createNote(path: string): Promise<FileNode> {
  return invoke<FileNode>("create_note", { path });
}

/** Create a new folder; resolves to the refreshed tree. */
export function createFolder(path: string): Promise<FileNode> {
  return invoke<FileNode>("create_folder", { path });
}

/** Rename/move a note or folder; resolves to the refreshed tree. */
export function renameEntry(from: string, to: string): Promise<FileNode> {
  return invoke<FileNode>("rename_entry", { from, to });
}

/** Compile all notes under `dir` into a single file at `output`; returns the tree. */
export function compileFolder(dir: string, output: string): Promise<FileNode> {
  return invoke<FileNode>("compile_folder", { dir, output });
}

/** Delete a note or folder; resolves to the refreshed tree. */
export function deleteEntry(path: string): Promise<FileNode> {
  return invoke<FileNode>("delete_entry", { path });
}

/** Render raw note text into sanitized HTML + parsed frontmatter + links/tags. */
export function renderMarkdown(content: string): Promise<RenderedNote> {
  return invoke<RenderedNote>("render_markdown", { content });
}

/** Toggle the index-th task-list checkbox in `content`; returns updated text. */
export function toggleTask(content: string, index: number): Promise<string> {
  return invoke<string>("toggle_task", { content, index });
}

/** Rebuild the vault link/tag index from disk. */
export function refreshIndex(): Promise<void> {
  return invoke<void>("refresh_index");
}

/** Get the note-relationship graph for the Graph View. */
export function getGraph(): Promise<GraphData> {
  return invoke<GraphData>("get_graph");
}

/** Get the notes that link to `path` (backlinks). */
export function getBacklinks(path: string): Promise<NoteRef[]> {
  return invoke<NoteRef[]>("get_backlinks", { path });
}

/** Get the vault-wide tag census (sorted by count). */
export function getTags(): Promise<TagCount[]> {
  return invoke<TagCount[]>("get_tags");
}

/** Get the notes carrying a given tag. */
export function notesWithTag(tag: string): Promise<NoteRef[]> {
  return invoke<NoteRef[]>("notes_with_tag", { tag });
}

/** Resolve a raw wikilink target to a note path, if one exists. */
export function resolveLink(target: string): Promise<string | null> {
  return invoke<string | null>("resolve_link", { target });
}

/**
 * Subscribe to external filesystem changes emitted by the Rust watcher.
 * Returns an unlisten function — call it on teardown to avoid leaks.
 */
export function onVaultChanged(
  handler: (event: ChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<ChangeEvent>("vault://changed", (e) => handler(e.payload));
}

/**
 * Subscribe to the backend's "the window wants to close" request. The handler
 * should flush unsaved edits and then close the window (the close was deferred
 * in Rust so edits aren't lost).
 */
export function onBeforeClose(handler: () => void | Promise<void>): Promise<UnlistenFn> {
  return listen("app://before-close", () => void handler());
}
