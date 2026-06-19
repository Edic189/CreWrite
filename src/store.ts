// Minimal observable app state. No framework — just a typed object plus a
// pub/sub so views can re-render when state changes. Keeps the Vanilla TS UI
// honest about where state lives without pulling in a library.

import type { FileNode } from "./types";

export interface AppStateShape {
  /** Absolute vault root path, or null if no vault is open. */
  vaultRoot: string | null;
  /** Current file tree (root node). */
  tree: FileNode | null;
  /** Relative path of the note open in the editor, or null. */
  activePath: string | null;
  /** Last-saved content of the active note (the on-disk baseline). */
  savedContent: string;
  /** Whether the editor has unsaved edits. */
  dirty: boolean;
}

type Listener = (state: Readonly<AppStateShape>) => void;

const state: AppStateShape = {
  vaultRoot: null,
  tree: null,
  activePath: null,
  savedContent: "",
  dirty: false,
};

const listeners = new Set<Listener>();

/** Read-only snapshot of the current state. */
export function getState(): Readonly<AppStateShape> {
  return state;
}

/** Shallow-merge a patch into state and notify subscribers. */
export function setState(patch: Partial<AppStateShape>): void {
  Object.assign(state, patch);
  for (const l of listeners) l(state);
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
