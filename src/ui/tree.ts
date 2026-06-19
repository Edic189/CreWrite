// File-tree view: renders a FileNode recursively into a collapsible <ul>.
// Pure DOM, no virtual-DOM — the tree is small and we rebuild it on changes.
//
// Interactions:
//  - Click a file  -> onOpenFile (and the editor sets the active dir to its parent).
//  - Click a folder -> toggle expand AND onSelectDir (folder becomes the
//    "active directory" that New note/folder create into).
//  - Drag a file/folder onto a folder (or the empty root area) -> onMove.

import type { FileNode } from "../types";
import { iconSvg } from "./icons";

export interface TreeCallbacks {
  /** A note was clicked. */
  onOpenFile: (path: string) => void;
  /** A folder was selected as the active directory ("" = vault root). */
  onSelectDir: (path: string) => void;
  /** An item was dragged onto a folder ("" = vault root) to be moved there. */
  onMove: (fromPath: string, toDir: string) => void;
}

/** Highlight state passed in on each render. */
export interface TreeHighlight {
  /** Path of the currently-selected row (a note or a folder); null = none. */
  selectedPath: string | null;
}

/** Folder open/closed state, keyed by relative path, survives re-renders. */
const expanded = new Set<string>();

/** Render `root.children` into `container` with the given highlight state. */
export function renderTree(
  container: HTMLElement,
  root: FileNode | null,
  highlight: TreeHighlight,
  cb: TreeCallbacks,
): void {
  container.replaceChildren();
  if (!root) return;

  const ul = document.createElement("ul");
  ul.className = "tree-root";
  for (const child of root.children) {
    ul.appendChild(renderNode(child, highlight, cb));
  }
  container.appendChild(ul);

  // The empty area of the container is a drop target for the vault root, and
  // clicking it clears the folder selection (back to root).
  makeDropTarget(container, "", cb, () => container.classList.remove("drop-root"), () =>
    container.classList.add("drop-root"),
  );
  container.addEventListener("click", (e) => {
    if (e.target === container) cb.onSelectDir("");
  });
}

function renderNode(node: FileNode, highlight: TreeHighlight, cb: TreeCallbacks): HTMLLIElement {
  const li = document.createElement("li");
  li.className = node.isDir ? "tree-dir" : "tree-file";

  const row = document.createElement("div");
  row.className = "tree-row";
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    e.dataTransfer?.setData("text/plain", node.path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });

  if (node.path === highlight.selectedPath) row.classList.add("selected");

  if (node.isDir) {
    const isOpen = expanded.has(node.path);
    // The folder icon (closed/open) doubles as the expand indicator.
    const icon = document.createElement("span");
    icon.className = "row-icon folder-icon";
    icon.innerHTML = iconSvg(isOpen ? "folderOpen" : "folder");

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = node.name;

    row.append(icon, label);

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expanded.has(node.path)) expanded.delete(node.path);
      else expanded.add(node.path);
      cb.onSelectDir(node.path); // triggers a re-render reflecting expand + selection
    });

    // Folders are drop targets.
    makeDropTarget(
      row,
      node.path,
      cb,
      () => row.classList.remove("drop-target"),
      () => row.classList.add("drop-target"),
    );

    li.appendChild(row);

    const childUl = document.createElement("ul");
    childUl.hidden = !isOpen;
    for (const child of node.children) {
      childUl.appendChild(renderNode(child, highlight, cb));
    }
    li.appendChild(childUl);
  } else {
    const icon = document.createElement("span");
    icon.className = "row-icon file-icon";
    icon.innerHTML = iconSvg("description");

    const label = document.createElement("span");
    label.className = "tree-label";
    // Drop the ".md" for a cleaner, Obsidian-like look.
    label.textContent = node.name.replace(/\.(md|markdown)$/i, "");

    row.append(icon, label);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onOpenFile(node.path);
    });
    li.appendChild(row);
  }

  return li;
}

/** Wire `el` as a drop target that moves the dragged item into `toDir`. */
function makeDropTarget(
  el: HTMLElement,
  toDir: string,
  cb: TreeCallbacks,
  clearHighlight: () => void,
  setHighlight: () => void,
): void {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setHighlight();
  });
  el.addEventListener("dragleave", clearHighlight);
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearHighlight();
    const from = e.dataTransfer?.getData("text/plain");
    if (from) cb.onMove(from, toDir);
  });
}

/** Ensure all ancestor folders of `path` are expanded (e.g. after creating). */
export function expandTo(path: string): void {
  const parts = path.split("/");
  parts.pop(); // drop the file/last segment itself
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    expanded.add(acc);
  }
}

/** Mark a folder path itself as expanded (so a newly-created folder opens). */
export function expandFolder(path: string): void {
  if (path) expanded.add(path);
}
