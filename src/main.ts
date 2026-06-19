// App entry point: builds the split-pane shell, wires the toolbar/tree/editor
// to the typed API in `api.ts`, and keeps the UI in sync with the Rust file
// watcher. Vanilla TS — DOM is constructed imperatively, state lives in store.

import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

import * as api from "./api";
import { getState, setState } from "./store";
import {
  DEFAULT_SETTINGS,
  isAppError,
  type AppInfo,
  type ChangeEvent,
  type FileNode,
  type NoteRef,
  type Settings,
  type VaultInfo,
} from "./types";
import { Editor } from "./ui/editor";
import { ExportPanel, type ExportOptions } from "./ui/export";
import { GraphView } from "./ui/graph";
import { iconSvg } from "./ui/icons";
import { mermaidToPngBase64 } from "./ui/mermaidImage";
import { confirmDialog, promptText } from "./ui/modal";
import { Preview } from "./ui/preview";
import { SettingsPanel } from "./ui/settings";
import { expandFolder, expandTo, renderTree } from "./ui/tree";

/** Trailing-edge debounce. */
function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: number | null = null;
  return (...args: A) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

// ---------------------------------------------------------------------------
// Shell markup
// ---------------------------------------------------------------------------

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <header class="sidebar-header">
        <span class="vault-name" id="vault-name">No vault</span>
        <div class="sidebar-actions">
          <button id="btn-graph" title="Graph view" disabled></button>
          <button id="btn-export" title="Export…" disabled></button>
          <button id="btn-compile" title="Compile folder into one file" disabled></button>
          <button id="btn-new-folder" title="New folder" disabled></button>
          <button id="btn-new" title="New note" disabled></button>
          <button id="btn-rename" title="Rename selected" disabled></button>
          <button id="btn-delete" title="Delete selected" disabled></button>
          <button id="btn-open" title="Open vault"></button>
        </div>
      </header>
      <input
        id="sidebar-search"
        class="sidebar-search"
        type="text"
        placeholder="Search notes…"
        spellcheck="false"
        disabled
      />
      <nav class="tree" id="tree">
        <div class="empty-hint">Open a vault to begin.</div>
      </nav>
      <div class="search-results" id="search-results" hidden></div>
      <footer class="sidebar-footer">
        <button id="btn-settings" title="Settings"></button>
      </footer>
    </aside>
    <main class="editor-pane">
      <header class="editor-header">
        <span class="note-title" id="note-title">—</span>
        <div class="editor-header-right">
          <span class="save-status" id="save-status"></span>
          <button id="btn-preview" class="toggle-btn" title="Show preview"></button>
        </div>
      </header>
      <input
        id="inline-title"
        class="inline-title"
        type="text"
        placeholder="Untitled"
        spellcheck="false"
        hidden
        disabled
      />
      <div class="editor-body mode-edit" id="editor-body">
        <div class="editor-mount" id="editor-mount"></div>
        <div class="preview" id="preview"></div>
      </div>
      <section class="context-panel" id="context-panel">
        <header class="context-header">
          <span class="context-title" id="context-title">Backlinks</span>
          <button id="btn-tags" class="toggle-btn" title="All tags"></button>
        </header>
        <div class="context-list" id="context-list"></div>
      </section>
    </main>
  </div>
`;

const el = {
  vaultName: document.querySelector<HTMLSpanElement>("#vault-name")!,
  btnGraph: document.querySelector<HTMLButtonElement>("#btn-graph")!,
  btnExport: document.querySelector<HTMLButtonElement>("#btn-export")!,
  btnCompile: document.querySelector<HTMLButtonElement>("#btn-compile")!,
  btnNewFolder: document.querySelector<HTMLButtonElement>("#btn-new-folder")!,
  btnNew: document.querySelector<HTMLButtonElement>("#btn-new")!,
  btnRename: document.querySelector<HTMLButtonElement>("#btn-rename")!,
  btnDelete: document.querySelector<HTMLButtonElement>("#btn-delete")!,
  btnOpen: document.querySelector<HTMLButtonElement>("#btn-open")!,
  sidebarSearch: document.querySelector<HTMLInputElement>("#sidebar-search")!,
  tree: document.querySelector<HTMLElement>("#tree")!,
  searchResults: document.querySelector<HTMLDivElement>("#search-results")!,
  noteTitle: document.querySelector<HTMLSpanElement>("#note-title")!,
  inlineTitle: document.querySelector<HTMLInputElement>("#inline-title")!,
  saveStatus: document.querySelector<HTMLSpanElement>("#save-status")!,
  btnPreview: document.querySelector<HTMLButtonElement>("#btn-preview")!,
  editorBody: document.querySelector<HTMLDivElement>("#editor-body")!,
  editorMount: document.querySelector<HTMLDivElement>("#editor-mount")!,
  preview: document.querySelector<HTMLDivElement>("#preview")!,
  btnTags: document.querySelector<HTMLButtonElement>("#btn-tags")!,
  contextTitle: document.querySelector<HTMLSpanElement>("#context-title")!,
  contextList: document.querySelector<HTMLDivElement>("#context-list")!,
  btnSettings: document.querySelector<HTMLButtonElement>("#btn-settings")!,
};

// Material Symbols icons for the toolbar controls (replaces emoji glyphs).
el.btnGraph.innerHTML = iconSvg("hub");
el.btnExport.innerHTML = iconSvg("download");
el.btnCompile.innerHTML = iconSvg("merge");
el.btnNewFolder.innerHTML = iconSvg("createNewFolder");
el.btnNew.innerHTML = iconSvg("noteAdd");
el.btnRename.innerHTML = iconSvg("rename");
el.btnDelete.innerHTML = iconSvg("delete");
el.btnOpen.innerHTML = iconSvg("folderOpen");
el.btnPreview.innerHTML = iconSvg("visibility");
el.btnTags.innerHTML = iconSvg("tag");
el.btnSettings.innerHTML = iconSvg("settings");

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const editor = new Editor(el.editorMount, {
  onInput: markEditing,
  onChange: (content) => void saveActiveNote(content),
  onSaveShortcut: () => void saveActiveNote(editor.getContent()),
  getLinkTargets: noteNames,
  getTags: () => cachedTags,
});

const preview = new Preview(el.preview, {
  onOpenPath: (path) => void openNote(path),
  onMissingLink: (target) => void createMissingNote(target),
  onTag: (tag) => void showTagResults(tag),
  onToggleTask: (index) => void toggleTask(index),
  onOpenExternal: (url) => void openExternal(url),
});
// Editor vs. preview are mutually exclusive (no split): false = edit, true =
// reading/preview. Start in edit mode.
let previewMode = false;

// The "active directory" new notes/folders are created into, and the drop
// fallback. "" = vault root. Set by clicking a folder or opening a note.
let selectedDir = "";

// The last-selected tree item — the target of the Delete button. Set when a
// folder is selected or a note is opened; the confirm dialog names it.
let selectedEntry: { path: string; isDir: boolean } | null = null;

// Tag names cached for the editor's `#` autocomplete (note names come straight
// from the tree). Refreshed on vault open and after the index rebuilds.
let cachedTags: string[] = [];

const graph = new GraphView(document.body, {
  onOpenNote: (path) => void openNote(path),
});

// User settings — defaults mirror the Rust `Settings::default()`. Replaced by
// the persisted values during init(); behavior fields are read at action time.
let settings: Settings = { ...DEFAULT_SETTINGS };

// Editor font choices map to CSS font stacks (applied via the --editor-font var).
const FONT_STACKS: Record<Settings["editorFontFamily"], string> = {
  mono: "var(--font-mono)",
  sans: "var(--font-ui)",
  serif: 'Georgia, Cambria, "Times New Roman", serif',
};

// Persisting on every keystroke of a color drag would spam the disk, so debounce
// the write; the visual apply (applySettings) still runs instantly per change.
const persistSettings = debounce((s: Settings) => void api.setSettings(s), 400);

const settingsPanel = new SettingsPanel(document.body, {
  onChange: (next) => {
    settings = next;
    applySettings(next);
    persistSettings(next);
  },
});

/** Apply settings that have a live visual/editor effect (others read on use). */
function applySettings(s: Settings): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", s.theme);
  applyAccent(s.accentColor);
  root.style.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  root.style.setProperty("--editor-font", FONT_STACKS[s.editorFontFamily] ?? FONT_STACKS.mono);
  root.style.setProperty("--editor-line-height", String(s.editorLineHeight));
  root.style.setProperty("--content-width", `${s.contentWidth}px`);
  root.classList.toggle("readable-width", s.readableLineWidth);
  editor.setLineWrap(s.lineWrap);
  editor.setSpellcheck(s.spellcheck);
  editor.setLineNumbers(s.lineNumbers);
  editor.setAutoPair(s.autoPair);
  editor.setIndent(s.tabSize, s.indentWithTabs);
  editor.setAutosaveDelay(s.autosaveMs);
}

/** Apply a custom accent (deriving hover/contrast/active-line), or clear it. */
function applyAccent(hex: string | null): void {
  const root = document.documentElement;
  const props = ["--accent", "--accent-hover", "--accent-text", "--accent-contrast", "--active-line"];
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    for (const p of props) root.style.removeProperty(p); // fall back to the theme
    return;
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = relLuminance(r, g, b);
  root.style.setProperty("--accent", hex);
  // Lift dark accents toward white on hover; settle light accents toward black.
  root.style.setProperty(
    "--accent-hover",
    lum < 0.5 ? mixHex(r, g, b, 255, 255, 255, 0.16) : mixHex(r, g, b, 0, 0, 0, 0.14),
  );
  root.style.setProperty("--accent-text", hex);
  root.style.setProperty("--accent-contrast", lum > 0.55 ? "#10171f" : "#ffffff");
  root.style.setProperty("--active-line", `rgba(${r}, ${g}, ${b}, 0.1)`);
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Mix an rgb color toward (tr,tg,tb) by `amt` (0..1) → "#rrggbb". */
function mixHex(
  r: number, g: number, b: number,
  tr: number, tg: number, tb: number,
  amt: number,
): string {
  const ch = (a: number, t: number) => Math.round(a + (t - a) * amt).toString(16).padStart(2, "0");
  return `#${ch(r, tr)}${ch(g, tg)}${ch(b, tb)}`;
}

const exportPanel = new ExportPanel(document.body, {
  onExport: (opts) => void runExport(opts),
});

/** Run a built-in export (DOCX/PDF generated in Rust, saved via a dialog). */
async function runExport(opts: ExportOptions): Promise<void> {
  try {
    setSaveStatus("Exporting…");
    // Mermaid diagrams embed as images in PDF only. For PDF, pre-render each
    // one to a PNG here in the webview (Mermaid is JS-only) and pass them to
    // Rust keyed by source. For DOCX we send nothing, so they export as source
    // text. Any diagram that fails to render falls back to its code block.
    const images: Record<string, string> = {};
    if (opts.format === "pdf") {
      try {
        const sources = await api.exportMermaidSources(
          opts.scope,
          opts.path,
          opts.combine,
          opts.stripFrontmatter,
        );
        if (sources.length) setSaveStatus(`Rendering ${sources.length} diagram${sources.length === 1 ? "" : "s"}…`);
        for (const src of sources) {
          try {
            images[src] = await mermaidToPngBase64(src);
          } catch (e) {
            console.warn("mermaid export render failed; keeping source as code", e);
          }
        }
        if (sources.length) setSaveStatus("Exporting…");
      } catch (e) {
        console.warn("mermaid source scan failed; exporting without diagrams", e);
      }
    }
    const count = await api.exportDocuments(
      opts.scope,
      opts.path,
      opts.combine,
      opts.stripFrontmatter,
      opts.format,
      images,
    );
    setSaveStatus(count != null ? `Exported ${count} file${count === 1 ? "" : "s"}` : "Saved");
  } catch (err) {
    reportError("export", err);
  }
}

// Context panel (backlinks / tag results / all tags) state, so we can refresh
// the right view after the index rebuilds.
type ContextMode = "backlinks" | "tag" | "tags";
let contextMode: ContextMode = "backlinks";
let currentTag: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Surface a backend error in a uniform way (console + status line). */
function reportError(context: string, err: unknown): void {
  const msg = isAppError(err) ? `${err.kind}: ${err.message}` : String(err);
  console.error(`[${context}]`, err);
  el.saveStatus.textContent = `⚠ ${msg}`;
  el.saveStatus.classList.add("error");
}

function clearError(): void {
  el.saveStatus.classList.remove("error");
}

function setSaveStatus(text: string): void {
  clearError();
  el.saveStatus.textContent = text;
}

/** Filename of a note path, without its `.md`/`.markdown` extension. */
function noteName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, "");
}

/** Parent directory of a path ("" if at the vault root). */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

/** Sync the editable inline title to the active note (hidden when none). */
function setInlineTitle(path: string | null): void {
  if (!path) {
    el.inlineTitle.hidden = true;
    el.inlineTitle.disabled = true;
    el.inlineTitle.value = "";
    return;
  }
  el.inlineTitle.hidden = false;
  el.inlineTitle.disabled = false;
  el.inlineTitle.value = noteName(path);
}

/** Rename the active note to `newName` (kept in its current folder). */
async function renameActiveNote(newName: string): Promise<void> {
  const { activePath } = getState();
  if (!activePath) return;
  const current = noteName(activePath);
  const name = newName.trim();

  if (!name || name === current) {
    el.inlineTitle.value = current; // no-op: restore display
    return;
  }
  if (/[/\\]/.test(name)) {
    reportError("rename", { kind: "InvalidPath", message: "Name can't contain slashes" });
    el.inlineTitle.value = current;
    return;
  }

  const dir = parentDir(activePath);
  const dest = `${dir ? `${dir}/` : ""}${name}.md`;
  const from = activePath;

  // Update activePath optimistically so the watcher's "removed(old)" event
  // doesn't mistake this for the open note being deleted out from under us.
  setState({ activePath: dest });
  try {
    const tree = await api.renameEntry(from, dest);
    setState({ tree });
    el.noteTitle.textContent = dest;
    el.inlineTitle.value = name;
    refreshTreeView();
    setSaveStatus("Renamed");
  } catch (err) {
    setState({ activePath: from }); // revert
    el.inlineTitle.value = current;
    reportError("renameActiveNote", err);
  }
}

function refreshTreeView(): void {
  const { tree } = getState();
  renderTree(
    el.tree,
    tree,
    { selectedPath: selectedEntry?.path ?? null },
    {
      onOpenFile: (p) => void openNote(p),
      onSelectDir: (p) => {
        selectedDir = p;
        selectedEntry = p ? { path: p, isDir: true } : null;
        refreshTreeView();
      },
      onMove: (from, toDir) => void moveEntry(from, toDir),
    },
  );
  // Keep search results in sync if a query is active.
  if (el.sidebarSearch.value.trim()) runSearch(el.sidebarSearch.value);
}

// --- Editor support (dirty flag + autocomplete data) -----------------------

/** Mark the active note as having unsaved edits (called on every keystroke). */
function markEditing(): void {
  const { dirty, activePath } = getState();
  if (activePath && !dirty) {
    setState({ dirty: true });
    setSaveStatus("Editing…");
  }
}

/** Unique note names for the editor's `[[` autocomplete. */
function noteNames(): string[] {
  const { tree } = getState();
  if (!tree) return [];
  const files: { path: string; name: string }[] = [];
  flattenFiles(tree, files);
  return [...new Set(files.map((f) => f.name))].sort((a, b) => a.localeCompare(b));
}

/** Refresh the cached tag list used by the editor's `#` autocomplete. */
async function refreshTagCache(): Promise<void> {
  try {
    cachedTags = (await api.getTags()).map((tc) => tc.tag);
  } catch {
    /* non-critical; keep the previous cache */
  }
}

// --- Filename search (client-side over the in-memory tree) -----------------

/** Flatten the tree into a list of notes (path + display name). */
function flattenFiles(node: FileNode, out: { path: string; name: string }[]): void {
  for (const child of node.children) {
    if (child.isDir) flattenFiles(child, out);
    else out.push({ path: child.path, name: noteName(child.path) });
  }
}

/** Show the file tree (hide search results). */
function showTree(): void {
  el.tree.hidden = false;
  el.searchResults.hidden = true;
}

/** Filter notes by filename and render the results, or fall back to the tree. */
function runSearch(query: string): void {
  const q = query.trim().toLowerCase();
  const { tree } = getState();
  if (!q || !tree) {
    showTree();
    return;
  }

  const files: { path: string; name: string }[] = [];
  flattenFiles(tree, files);

  const scored = files
    .map((f) => {
      // Filename-only matching (the path is shown only for disambiguation).
      const name = f.name.toLowerCase();
      let score = -1;
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.includes(q)) score = 2;
      return { ...f, score };
    })
    .filter((f) => f.score >= 0)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 100);

  el.searchResults.replaceChildren();
  if (scored.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-hint";
    empty.textContent = "No matching notes.";
    el.searchResults.appendChild(empty);
  } else {
    for (const m of scored) {
      const row = document.createElement("div");
      row.className = "search-item";
      const title = document.createElement("span");
      title.className = "search-item-title";
      title.textContent = m.name;
      const path = document.createElement("span");
      path.className = "search-item-path";
      path.textContent = m.path;
      row.append(title, path);
      row.addEventListener("click", () => void openNote(m.path));
      el.searchResults.appendChild(row);
    }
  }
  el.tree.hidden = true;
  el.searchResults.hidden = false;
}

/** Open the first search result (Enter in the search box). */
function openFirstResult(): void {
  const first = el.searchResults.querySelector<HTMLElement>(".search-item");
  const path = first?.querySelector(".search-item-path")?.textContent;
  if (path) void openNote(path);
}

/** Re-render the preview from the current editor buffer (only in preview mode). */
async function updatePreview(): Promise<void> {
  if (!previewMode) return;
  const { activePath } = getState();
  if (!activePath) {
    preview.setEmpty();
    return;
  }
  try {
    const rendered = await api.renderMarkdown(editor.getContent());
    await preview.render(rendered);
  } catch (err) {
    reportError("renderMarkdown", err);
  }
}

/** Switch between editing and reading (preview) — full-width, never split. */
function setPreviewMode(enabled: boolean): void {
  previewMode = enabled;
  el.editorBody.classList.toggle("mode-preview", enabled);
  el.editorBody.classList.toggle("mode-edit", !enabled);
  el.btnPreview.classList.toggle("active", enabled);
  el.btnPreview.innerHTML = iconSvg(enabled ? "edit" : "visibility");
  el.btnPreview.title = enabled ? "Back to editing" : "Show preview";
  if (enabled) void updatePreview();
  else editor.focus();
}

// ---------------------------------------------------------------------------
// Context panel (backlinks / tag results / all tags) + graph
// ---------------------------------------------------------------------------

function contextEmpty(text: string): void {
  el.contextList.replaceChildren();
  const hint = document.createElement("div");
  hint.className = "context-empty";
  hint.textContent = text;
  el.contextList.appendChild(hint);
}

function renderNoteList(refs: NoteRef[]): void {
  if (refs.length === 0) {
    contextEmpty("Nothing here.");
    return;
  }
  el.contextList.replaceChildren();
  for (const ref of refs) {
    const row = document.createElement("div");
    row.className = "context-item";
    const title = document.createElement("span");
    title.className = "context-item-title";
    title.textContent = ref.title;
    const path = document.createElement("span");
    path.className = "context-item-path";
    path.textContent = ref.path;
    row.append(title, path);
    row.addEventListener("click", () => void openNote(ref.path));
    el.contextList.appendChild(row);
  }
}

async function showBacklinks(): Promise<void> {
  contextMode = "backlinks";
  currentTag = null;
  el.contextTitle.textContent = "Backlinks";
  el.btnTags.classList.remove("active");

  const { activePath, vaultRoot } = getState();
  if (!vaultRoot) {
    contextEmpty("Open a vault.");
    return;
  }
  if (!activePath) {
    contextEmpty("No note open.");
    return;
  }
  try {
    const refs = await api.getBacklinks(activePath);
    // Guard against a slower request landing after the user switched notes.
    if (getState().activePath === activePath) renderNoteList(refs);
  } catch (err) {
    reportError("getBacklinks", err);
  }
}

async function showTagResults(tag: string): Promise<void> {
  contextMode = "tag";
  currentTag = tag;
  el.contextTitle.textContent = `#${tag}`;
  el.btnTags.classList.remove("active");
  try {
    renderNoteList(await api.notesWithTag(tag));
  } catch (err) {
    reportError("notesWithTag", err);
  }
}

async function showAllTags(): Promise<void> {
  contextMode = "tags";
  currentTag = null;
  el.contextTitle.textContent = "Tags";
  el.btnTags.classList.add("active");
  try {
    const tags = await api.getTags();
    if (tags.length === 0) {
      contextEmpty("No tags yet.");
      return;
    }
    el.contextList.replaceChildren();
    const cloud = document.createElement("div");
    cloud.className = "tag-cloud";
    for (const t of tags) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = `#${t.tag}`;
      const count = document.createElement("span");
      count.className = "tag-count";
      count.textContent = String(t.count);
      chip.appendChild(count);
      chip.addEventListener("click", () => void showTagResults(t.tag));
      cloud.appendChild(chip);
    }
    el.contextList.appendChild(cloud);
  } catch (err) {
    reportError("getTags", err);
  }
}

/** Re-render whichever context view is currently active. */
async function refreshContext(): Promise<void> {
  if (contextMode === "tag" && currentTag) await showTagResults(currentTag);
  else if (contextMode === "tags") await showAllTags();
  else await showBacklinks();
}

/** Rebuild the index after edits settle, then refresh the context view. */
const scheduleIndexRefresh = debounce(() => {
  void (async () => {
    try {
      await api.refreshIndex();
      await refreshContext();
      await refreshTagCache();
    } catch (err) {
      reportError("refreshIndex", err);
    }
  })();
}, 1200);

/** Open an external link in the system browser (never in the app webview). */
async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (err) {
    reportError("openExternal", err);
  }
}

async function openGraph(): Promise<void> {
  const { vaultRoot } = getState();
  if (!vaultRoot) return;
  try {
    await api.refreshIndex();
    graph.open(await api.getGraph());
  } catch (err) {
    reportError("getGraph", err);
  }
}

async function createMissingNote(target: string): Promise<void> {
  const path = /\.(md|markdown)$/i.test(target) ? target : `${target}.md`;
  const ok = await confirmDialog({
    title: "Create note?",
    message: `"${target}" doesn't exist yet. Create ${path}?`,
    confirmLabel: "Create",
  });
  if (!ok) return;
  try {
    const tree = await api.createNote(path);
    expandTo(path);
    setState({ tree });
    refreshTreeView();
    await openNote(path);
  } catch (err) {
    reportError("createMissingNote", err);
  }
}

/** Toggle a preview task-list checkbox: flip it in the source and persist. */
async function toggleTask(index: number): Promise<void> {
  const { activePath } = getState();
  if (!activePath) return;
  try {
    const current = editor.getContent();
    const updated = await api.toggleTask(current, index);
    if (updated === current) return;
    editor.setContent(updated);
    await saveActiveNote(updated);
    void updatePreview();
  } catch (err) {
    reportError("toggleTask", err);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Apply a freshly-opened vault to the UI (shared by picker + by-path open). */
function applyVault(info: VaultInfo): void {
  setState({
    vaultRoot: info.root,
    tree: info.tree,
    activePath: null,
    savedContent: "",
    dirty: false,
  });
  selectedDir = ""; // reset folder context to root
  selectedEntry = null;
  el.vaultName.textContent = info.root.split(/[\\/]/).pop() || info.root;
  el.vaultName.title = info.root;
  for (const b of [
    el.btnNew,
    el.btnNewFolder,
    el.btnGraph,
    el.btnExport,
    el.btnCompile,
    el.btnRename,
    el.btnDelete,
  ]) {
    b.disabled = false;
  }
  el.sidebarSearch.disabled = false;
  el.sidebarSearch.value = "";
  showTree();
  el.noteTitle.textContent = "—";
  setInlineTitle(null);
  setSaveStatus("");
  editor.clear();
  preview.setEmpty();
  refreshTreeView();
  void showBacklinks();
  void refreshTagCache(); // seed editor #-autocomplete
}

/** Open the native folder picker and load the chosen vault. */
async function openVault(): Promise<void> {
  try {
    const info = await api.selectVault();
    if (info) applyVault(info); // null = user cancelled
  } catch (err) {
    reportError("openVault", err);
  }
}

/** Open a vault at a known path (auto-reopen / recent vault). */
async function openVaultByPath(path: string): Promise<void> {
  applyVault(await api.openVault(path));
}

/** Render the empty (no-vault) state with a clickable list of recent vaults. */
async function renderEmptyState(): Promise<void> {
  let recent: string[] = [];
  try {
    recent = await api.getRecentVaults();
  } catch {
    /* no config yet — show the plain hint */
  }

  el.tree.replaceChildren();
  const hint = document.createElement("div");
  hint.className = "empty-hint";
  hint.textContent = recent.length
    ? "Open a vault, or pick a recent one:"
    : "Open a vault to begin.";
  el.tree.appendChild(hint);

  if (recent.length === 0) return;
  const list = document.createElement("div");
  list.className = "recent-list";
  for (const path of recent) {
    const item = document.createElement("div");
    item.className = "recent-item";
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = path.split(/[\\/]/).pop() || path;
    const full = document.createElement("span");
    full.className = "recent-path";
    full.textContent = path;
    item.append(name, full);
    item.addEventListener("click", () => {
      void openVaultByPath(path).catch((err) => reportError("openRecent", err));
    });
    list.appendChild(item);
  }
  el.tree.appendChild(list);
}

/** On launch: load settings, then auto-reopen the last vault or show recents. */
async function init(): Promise<void> {
  // Load + apply settings first so the theme/font are right before anything paints.
  try {
    settings = await api.getSettings();
    applySettings(settings);
  } catch (err) {
    reportError("getSettings", err); // keep defaults
  }

  try {
    const last = await api.getLastVault();
    if (last) {
      await openVaultByPath(last);
      return;
    }
  } catch (err) {
    reportError("autoReopen", err); // vault gone/moved — fall back to recents
  }
  await renderEmptyState();
}

async function openNote(path: string): Promise<void> {
  try {
    const content = await api.readNote(path);
    setState({ activePath: path, savedContent: content, dirty: false });
    // New notes/folders default to the open note's folder; the note becomes
    // the delete target.
    const slash = path.lastIndexOf("/");
    selectedDir = slash >= 0 ? path.slice(0, slash) : "";
    selectedEntry = { path, isDir: false };
    el.noteTitle.textContent = path;
    setInlineTitle(path);
    setSaveStatus("Saved");
    editor.setContent(content);
    // Open in the configured default view (focuses the editor, or renders preview).
    setPreviewMode(settings.defaultView === "preview");
    refreshTreeView();
    void showBacklinks();
  } catch (err) {
    reportError("openNote", err);
  }
}

async function saveActiveNote(content: string): Promise<void> {
  const { activePath, savedContent } = getState();
  if (!activePath) return;
  if (content === savedContent) {
    setState({ dirty: false });
    setSaveStatus("Saved");
    return;
  }
  try {
    setSaveStatus("Saving…");
    await api.writeNote(activePath, content);
    setState({ savedContent: content, dirty: false });
    setSaveStatus("Saved");
    // Links/tags may have changed — rebuild the index once edits settle.
    scheduleIndexRefresh();
  } catch (err) {
    reportError("saveActiveNote", err);
  }
}

/**
 * Immediately persist the active note if it has unsaved edits, bypassing the
 * editor's debounce. Called on window blur/hide/close so a fast type-then-quit
 * doesn't lose the last keystrokes.
 */
async function flushSave(): Promise<void> {
  const { activePath, dirty } = getState();
  if (!activePath || !dirty) return;
  await saveActiveNote(editor.getContent());
}

/** Join the active directory with a relative name ("" dir → just the name). */
function inSelectedDir(name: string): string {
  return selectedDir ? `${selectedDir}/${name}` : name;
}

async function newNote(): Promise<void> {
  const { vaultRoot } = getState();
  if (!vaultRoot) return;
  const input = await promptText({
    title: selectedDir ? `New note in ${selectedDir}/` : "New note",
    value: "untitled.md",
    placeholder: "idea.md",
  });
  if (!input) return;
  const named = /\.(md|markdown)$/i.test(input) ? input : `${input}.md`;
  const path = settings.newNoteLocation === "root" ? named : inSelectedDir(named);
  try {
    const tree = await api.createNote(path);
    expandTo(path);
    setState({ tree });
    refreshTreeView();
    await openNote(path);
  } catch (err) {
    reportError("newNote", err);
  }
}

async function newFolder(): Promise<void> {
  const { vaultRoot } = getState();
  if (!vaultRoot) return;
  const input = await promptText({
    title: selectedDir ? `New folder in ${selectedDir}/` : "New folder",
    placeholder: "ideas",
  });
  if (!input) return;
  const path = inSelectedDir(input);
  try {
    const tree = await api.createFolder(path);
    expandTo(path); // open ancestor folders…
    expandFolder(path); // …and the new folder itself
    setState({ tree });
    refreshTreeView();
  } catch (err) {
    reportError("newFolder", err);
  }
}

/** Compile the selected folder's notes into a single file (prompts for name). */
async function compileFolder(): Promise<void> {
  const { vaultRoot } = getState();
  if (!vaultRoot) return;

  // Default the output to a file *outside* the folder (in its parent), named
  // after the folder. "" (root selected) compiles the whole vault.
  const folderName = selectedDir ? selectedDir.split("/").pop()! : "vault";
  const slash = selectedDir.lastIndexOf("/");
  const parent = slash >= 0 ? selectedDir.slice(0, slash) : "";
  const defaultOutput = parent ? `${parent}/${folderName}.md` : `${folderName}.md`;

  const input = await promptText({
    title: selectedDir ? `Compile "${selectedDir}/" to…` : "Compile vault to…",
    value: defaultOutput,
    placeholder: "compiled.md",
    confirmLabel: "Compile",
  });
  if (!input) return;
  const output = /\.(md|markdown)$/i.test(input) ? input : `${input}.md`;

  try {
    const tree = await api.compileFolder(selectedDir, output);
    expandTo(output);
    setState({ tree });
    refreshTreeView();
    await openNote(output); // show the result
  } catch (err) {
    reportError("compileFolder", err);
  }
}

/** Rename the selected note/folder via a popup (kept in its current folder). */
async function renameSelected(): Promise<void> {
  const entry = selectedEntry;
  if (!entry) {
    setSaveStatus("Select a note or folder to rename");
    return;
  }

  // Preserve a note's extension; folders have none.
  const ext = entry.isDir ? "" : (entry.path.match(/\.(md|markdown)$/i)?.[0] ?? "");
  const currentName = entry.isDir
    ? (entry.path.split("/").pop() ?? entry.path)
    : noteName(entry.path);

  const input = await promptText({
    title: entry.isDir ? "Rename folder" : "Rename note",
    value: currentName,
    confirmLabel: "Rename",
  });
  if (!input) return;
  const name = input.trim();
  if (!name || name === currentName) return;
  if (/[/\\]/.test(name)) {
    reportError("rename", { kind: "InvalidPath", message: "Name can't contain slashes" });
    return;
  }

  const from = entry.path;
  const parent = parentDir(from);
  const dest = `${parent ? `${parent}/` : ""}${name}${ext}`;
  if (dest === from) return;

  // Optimistically retarget the open note (if it is, or is inside, the renamed
  // item) so the watcher's "removed(old)" event doesn't clear it.
  const { activePath: prevActive } = getState();
  let newActive = prevActive;
  if (prevActive === from) newActive = dest;
  else if (prevActive && prevActive.startsWith(`${from}/`)) {
    newActive = dest + prevActive.slice(from.length);
  }
  if (newActive !== prevActive) {
    setState({ activePath: newActive });
    el.noteTitle.textContent = newActive!;
    setInlineTitle(newActive);
  }

  try {
    const tree = await api.renameEntry(from, dest);
    // Fix the folder-context selection if it pointed into the renamed path.
    if (selectedDir === from) selectedDir = dest;
    else if (selectedDir.startsWith(`${from}/`)) selectedDir = dest + selectedDir.slice(from.length);
    selectedEntry = { path: dest, isDir: entry.isDir };
    expandTo(dest);
    if (entry.isDir) expandFolder(dest);
    setState({ tree });
    refreshTreeView();
    await refreshContext();
    setSaveStatus("Renamed");
  } catch (err) {
    if (newActive !== prevActive) {
      setState({ activePath: prevActive });
      el.noteTitle.textContent = prevActive ?? "—";
      setInlineTitle(prevActive ?? null);
    }
    reportError("renameSelected", err);
  }
}

/** Permanently delete the selected note/folder (after confirmation). */
async function deleteSelected(): Promise<void> {
  const entry = selectedEntry;
  if (!entry) {
    setSaveStatus("Select a note or folder to delete");
    return;
  }
  const what = entry.isDir
    ? `folder "${entry.path}" and everything inside it`
    : `"${entry.path}"`;
  const ok =
    !settings.confirmDelete ||
    (await confirmDialog({
      title: "Move to Trash?",
      message: `Move ${what} to the Trash?`,
      confirmLabel: "Move to Trash",
    }));
  if (!ok) return;

  try {
    const tree = await api.deleteEntry(entry.path);

    // If the open note was deleted (directly or via its folder), clear it.
    const { activePath } = getState();
    if (activePath && (activePath === entry.path || activePath.startsWith(`${entry.path}/`))) {
      setState({ activePath: null, savedContent: "", dirty: false });
      el.noteTitle.textContent = "—";
      setInlineTitle(null);
      editor.clear();
      preview.setEmpty();
    }
    // Reset the folder context if it pointed into the deleted path.
    if (selectedDir === entry.path || selectedDir.startsWith(`${entry.path}/`)) {
      selectedDir = "";
    }
    selectedEntry = null;

    setState({ tree });
    refreshTreeView();
    await refreshContext();
    setSaveStatus("Moved to Trash");
  } catch (err) {
    reportError("deleteSelected", err);
  }
}

/** Move a note/folder into `toDir` ("" = vault root) via drag & drop. */
async function moveEntry(fromPath: string, toDir: string): Promise<void> {
  const name = fromPath.split("/").pop();
  if (!name) return;
  const dest = toDir ? `${toDir}/${name}` : name;
  if (dest === fromPath) return; // dropped back into its current location
  // Can't move a folder into itself or one of its descendants.
  if (toDir === fromPath || toDir.startsWith(`${fromPath}/`)) {
    reportError("moveEntry", {
      kind: "InvalidPath",
      message: "Can't move a folder into itself",
    });
    return;
  }
  try {
    const tree = await api.renameEntry(fromPath, dest);
    expandTo(dest);
    // Keep the open note's path correct if it (or its folder) was moved.
    const { activePath } = getState();
    if (activePath === fromPath) {
      setState({ activePath: dest });
      el.noteTitle.textContent = dest;
    } else if (activePath && activePath.startsWith(`${fromPath}/`)) {
      const moved = dest + activePath.slice(fromPath.length);
      setState({ activePath: moved });
      el.noteTitle.textContent = moved;
    }
    setState({ tree });
    refreshTreeView();
  } catch (err) {
    reportError("moveEntry", err);
  }
}

// ---------------------------------------------------------------------------
// External change sync (Rust file watcher)
// ---------------------------------------------------------------------------

async function handleVaultChanged(event: ChangeEvent): Promise<void> {
  const { activePath, dirty } = getState();

  // Structural changes: refresh the tree, then rebuild the index (links/tags/
  // graph) and the context panel to reflect notes added/removed externally.
  if (event.kind !== "modified") {
    try {
      const tree = await api.readVaultTree();
      setState({ tree });
      refreshTreeView();
      await api.refreshIndex();
      await refreshContext();
      await refreshTagCache();
    } catch (err) {
      reportError("watcher.refreshTree", err);
    }
  }

  if (!activePath) return;
  const touchesActive = event.paths.includes(activePath);
  if (!touchesActive) return;

  if (event.kind === "removed") {
    setState({ activePath: null, savedContent: "", dirty: false });
    el.noteTitle.textContent = "—";
    setInlineTitle(null);
    setSaveStatus("File deleted on disk");
    editor.clear();
    preview.setEmpty();
    refreshTreeView();
    return;
  }

  // Active note changed on disk. Don't clobber unsaved local edits.
  if (event.kind === "modified") {
    if (dirty) {
      setSaveStatus("⚠ Changed on disk — local edits unsaved");
      return;
    }
    try {
      const content = await api.readNote(activePath);
      // Ignore the echo of our own save (content already matches the buffer).
      if (content === editor.getContent()) {
        setState({ savedContent: content });
        return;
      }
      setState({ savedContent: content, dirty: false });
      editor.setContent(content);
      void updatePreview();
      setSaveStatus("Reloaded from disk");
    } catch (err) {
      reportError("watcher.reload", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

el.btnOpen.addEventListener("click", () => void openVault());
el.btnNew.addEventListener("click", () => void newNote());
el.btnNewFolder.addEventListener("click", () => void newFolder());
el.btnGraph.addEventListener("click", () => void openGraph());
el.btnSettings.addEventListener("click", () => void openSettings());

/** Gather version/config/vault info for the About tab, then open the panel. */
async function openSettings(): Promise<void> {
  let info: AppInfo = { version: "—", configPath: null };
  try {
    info = await api.appInfo();
  } catch {
    /* non-critical — About just shows placeholders */
  }
  settingsPanel.open(settings, { ...info, vaultPath: getState().vaultRoot ?? null });
}
el.btnExport.addEventListener("click", () =>
  exportPanel.open({ activePath: getState().activePath, selectedDir }),
);
el.btnCompile.addEventListener("click", () => void compileFolder());
el.btnRename.addEventListener("click", () => void renameSelected());
el.btnDelete.addEventListener("click", () => void deleteSelected());

// Sidebar filename search.
el.sidebarSearch.addEventListener("input", () => runSearch(el.sidebarSearch.value));
el.sidebarSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    openFirstResult();
  } else if (e.key === "Escape") {
    e.preventDefault();
    el.sidebarSearch.value = "";
    showTree();
    el.sidebarSearch.blur();
  }
});

// Inline title: Enter commits (rename), Escape reverts, blur commits.
el.inlineTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    el.inlineTitle.blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    const { activePath } = getState();
    el.inlineTitle.value = activePath ? noteName(activePath) : "";
    el.inlineTitle.blur();
  }
});
el.inlineTitle.addEventListener("blur", () => void renameActiveNote(el.inlineTitle.value));
el.btnPreview.addEventListener("click", () => setPreviewMode(!previewMode));
el.btnTags.addEventListener("click", () => {
  if (contextMode === "tags") void showBacklinks();
  else void showAllTags();
});

// (The editor reports keystrokes via its onInput callback → markEditing.)

void api.onVaultChanged((event) => void handleVaultChanged(event));

// --- Data-loss protection: flush unsaved edits on blur / hide / quit -------

// Blur and hide are reliable (the page isn't tearing down, so the async save
// completes). beforeunload is best-effort only.
window.addEventListener("blur", () => void flushSave());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void flushSave();
});
window.addEventListener("beforeunload", () => void flushSave());

// The reliable quit path: Rust defers the window close and emits this; we save,
// then close for real via destroy(). `finally` guarantees we never trap the user.
void api.onBeforeClose(async () => {
  try {
    await flushSave();
  } finally {
    await getCurrentWindow().destroy();
  }
});

// Auto-reopen the last vault (or show recent vaults).
void init();
