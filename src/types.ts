// TypeScript mirrors of the Rust types returned over the Tauri bridge.
// These MUST stay in sync with `src-tauri/src` (serde uses camelCase).

/** One entry in the vault explorer. Files have an empty `children` array. */
export interface FileNode {
  /** Display name (final path segment). */
  name: string;
  /** Forward-slash path relative to the vault root. "" === the root. */
  path: string;
  /** True for directories. */
  isDir: boolean;
  /** Child nodes (dirs first, then alphabetical). Empty for files. */
  children: FileNode[];
}

/** Everything needed to render a freshly-opened vault. */
export interface VaultInfo {
  /** Absolute path of the vault root. */
  root: string;
  /** The full recursive file tree (root node has path ""). */
  tree: FileNode;
}

/** A wikilink and its resolution (matches the Rust `ResolvedLink`). */
export interface ResolvedLink {
  /** Raw target text (alias/heading stripped). */
  target: string;
  /** Resolved vault-relative path, or null if no matching note exists. */
  path: string | null;
}

/** Result of rendering a note's raw text (from the `render_markdown` command). */
export interface RenderedNote {
  /** Sanitized HTML for the body (frontmatter excluded). Safe to inject. */
  html: string;
  /** Parsed YAML frontmatter (a mapping), or null if none was present. */
  frontmatter: Record<string, unknown> | null;
  /** YAML parse error message if the frontmatter block was malformed. */
  frontmatterError: string | null;
  /** Wikilinks found in the body. */
  links: ResolvedLink[];
  /** Tags found in the body (without the leading `#`). */
  tags: string[];
}

/** User settings (mirrors the Rust `Settings`). */
export type Theme = "dark" | "light" | "grey" | "forest" | "winter" | "sea" | "retro" | "summer";
export type FontFamily = "mono" | "sans" | "serif";

export interface Settings {
  theme: Theme;
  /** Hex accent override, or null to use the theme's accent. */
  accentColor: string | null;
  editorFontSize: number;
  editorFontFamily: FontFamily;
  editorLineHeight: number;
  readableLineWidth: boolean;
  contentWidth: number;
  lineWrap: boolean;
  spellcheck: boolean;
  lineNumbers: boolean;
  autoPair: boolean;
  indentWithTabs: boolean;
  tabSize: number;
  defaultView: "edit" | "preview";
  newNoteLocation: "root" | "current";
  autosaveMs: number;
  confirmDelete: boolean;
}

/** Defaults — must mirror the Rust `Settings::default()`. */
export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accentColor: null,
  editorFontSize: 15,
  editorFontFamily: "mono",
  editorLineHeight: 1.7,
  readableLineWidth: false,
  contentWidth: 720,
  lineWrap: true,
  spellcheck: false,
  lineNumbers: false,
  autoPair: true,
  indentWithTabs: false,
  tabSize: 4,
  defaultView: "edit",
  newNoteLocation: "current",
  autosaveMs: 600,
  confirmDelete: true,
};

/** App version + config location (from the `app_info` command). */
export interface AppInfo {
  version: string;
  configPath: string | null;
}

/** Git state of the current vault (mirrors the Rust `GitStatus`). */
export interface GitStatus {
  /** The vault is its own Git repository. */
  isRepo: boolean;
  /** At least one commit exists (Discard has a baseline). */
  hasHead: boolean;
  /** Files changed since the last commit. */
  filesChanged: number;
  /** Lines inserted since the last commit. */
  added: number;
  /** Lines deleted since the last commit. */
  removed: number;
}

/** A note reference (backlinks, tag results). */
export interface NoteRef {
  path: string;
  title: string;
}

/** A tag with its note count. */
export interface TagCount {
  tag: string;
  count: number;
}

/** A node in the relationship graph. */
export interface GraphNode {
  id: string;
  label: string;
  tags: string[];
  degree: number;
}

/** A directed edge (source links to target). */
export interface GraphEdge {
  source: string;
  target: string;
}

/** The full graph payload for the Graph View. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Normalized filesystem change pushed from the Rust watcher. */
export interface ChangeEvent {
  kind: "created" | "modified" | "removed" | "other";
  /** Vault-relative, forward-slash paths affected. */
  paths: string[];
}

/** Shape of a rejected `invoke(...)` — matches `AppError`'s Serialize impl. */
export interface AppError {
  kind:
    | "NoVaultOpen"
    | "PathOutsideVault"
    | "InvalidPath"
    | "NotMarkdown"
    | "NotFound"
    | "Io"
    | "Watcher"
    | "LockPoisoned"
    | string;
  message: string;
}

/** Type guard so callers can branch on a backend error safely. */
export function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    "message" in err
  );
}
