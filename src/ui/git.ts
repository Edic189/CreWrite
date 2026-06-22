// Git panel: a compact versioning strip in the sidebar (just above the settings
// gear). Before a repo exists it shows a single "Initialize Git" button; once
// it does, it shows the change counts (+added / −removed / files) and two
// buttons — Commit and Discard. Pure DOM, matching the app's style.

import type { GitStatus } from "../types";

export interface GitCallbacks {
  /** Create a Git repo in the vault. */
  onInit: () => void;
  /** Commit all current changes. */
  onCommit: () => void;
  /** Discard all changes since the last commit. */
  onDiscard: () => void;
}

export class GitPanel {
  private root: HTMLElement;

  constructor(mount: HTMLElement, private cb: GitCallbacks) {
    this.root = document.createElement("section");
    this.root.className = "git-panel";
    this.root.hidden = true; // shown once a vault is open
    mount.appendChild(this.root);
  }

  /** Render the panel for `status`; `null` hides it (no vault open). */
  render(status: GitStatus | null): void {
    this.root.replaceChildren();
    if (!status) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;

    const label = document.createElement("div");
    label.className = "git-label";
    label.textContent = "Git";
    this.root.appendChild(label);

    if (!status.isRepo) {
      this.root.appendChild(
        this.button("Initialize Git", "git-btn git-init", "Create a Git repository in this vault", false, this.cb.onInit),
      );
      return;
    }

    const hasChanges = status.filesChanged > 0;

    const stat = document.createElement("div");
    stat.className = "git-stat";
    if (!hasChanges) {
      const clean = document.createElement("span");
      clean.className = "git-clean";
      clean.textContent = "✓ No changes";
      stat.appendChild(clean);
    } else {
      const added = document.createElement("span");
      added.className = "git-added";
      added.textContent = `+${status.added}`;
      const removed = document.createElement("span");
      removed.className = "git-removed";
      removed.textContent = `−${status.removed}`;
      const files = document.createElement("span");
      files.className = "git-files";
      files.textContent = `${status.filesChanged} file${status.filesChanged === 1 ? "" : "s"}`;
      stat.append(added, removed, files);
    }
    this.root.appendChild(stat);

    const actions = document.createElement("div");
    actions.className = "git-actions";
    actions.append(
      this.button("Commit", "git-btn", "Commit all changes", !hasChanges, this.cb.onCommit),
      this.button(
        "Discard",
        "git-btn git-danger",
        status.hasHead ? "Discard all changes since the last commit" : "Commit first to enable discard",
        !hasChanges || !status.hasHead,
        this.cb.onDiscard,
      ),
    );
    this.root.appendChild(actions);
  }

  private button(text: string, cls: string, title: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.textContent = text;
    btn.title = title;
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    return btn;
  }
}
