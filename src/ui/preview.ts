// Preview pane: renders a note's frontmatter (a "properties" panel) and its
// HTML body. The HTML is sanitized server-side by `ammonia`, so injecting it
// via innerHTML is safe here. Frontmatter *values* are still set via
// textContent — they're data, never markup.
//
// Phase 3 adds: click handling for wikilinks (navigate / create-on-missing) and
// tags (filter), plus lazy Mermaid rendering for ```mermaid fenced blocks.

import type { RenderedNote } from "../types";

export interface PreviewCallbacks {
  /** A resolved wikilink was clicked → open this note path. */
  onOpenPath: (path: string) => void;
  /** A missing wikilink was clicked → offer to create this target. */
  onMissingLink: (target: string) => void;
  /** A tag chip was clicked. */
  onTag: (tag: string) => void;
  /** A task-list checkbox was clicked → toggle the index-th task in source. */
  onToggleTask: (index: number) => void;
  /** An external link (http/mailto) was clicked → open it outside the app. */
  onOpenExternal: (url: string) => void;
}

/** Copy text to the clipboard, with a fallback for older webviews. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

let mermaidSeq = 0;

export class Preview {
  private propsEl: HTMLDivElement;
  private bodyEl: HTMLDivElement;

  constructor(mount: HTMLElement, private cb: PreviewCallbacks) {
    this.propsEl = document.createElement("div");
    this.propsEl.className = "properties";
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "md-body";
    mount.append(this.propsEl, this.bodyEl);
    this.bodyEl.addEventListener("click", (e) => this.onBodyClick(e));
    this.setEmpty();
  }

  /** Show the "no note" placeholder. */
  setEmpty(): void {
    this.propsEl.replaceChildren();
    this.propsEl.hidden = true;
    this.bodyEl.replaceChildren();
    const hint = document.createElement("div");
    hint.className = "preview-empty";
    hint.textContent = "Nothing to preview.";
    this.bodyEl.appendChild(hint);
  }

  /** Render a freshly-computed note. */
  async render(note: RenderedNote): Promise<void> {
    this.renderProperties(note);
    // Safe: `html` is sanitized in the Rust backend before it reaches us.
    this.bodyEl.innerHTML = note.html;
    this.enableTaskCheckboxes();
    await this.renderMermaid(); // replaces mermaid <pre>s before copy buttons
    this.addCopyButtons();
  }

  /** Make GFM task-list checkboxes clickable (pulldown renders them disabled). */
  private enableTaskCheckboxes(): void {
    const boxes = this.bodyEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    boxes.forEach((box, index) => {
      box.disabled = false;
      box.classList.add("task-check");
      box.addEventListener("click", (e) => {
        // Source markdown is the truth; prevent the browser's own toggle and
        // let the re-render reflect the new state.
        e.preventDefault();
        this.cb.onToggleTask(index);
      });
    });
  }

  /** Add a "Copy" button to each code block. */
  private addCopyButtons(): void {
    this.bodyEl.querySelectorAll("pre").forEach((pre) => {
      if (pre.parentElement?.classList.contains("code-block")) return; // already wrapped
      // Wrap the <pre> in a non-scrolling container and anchor the button to it,
      // so the button stays put when the code scrolls horizontally (rather than
      // scrolling away with the <pre>'s content).
      const wrapper = document.createElement("div");
      wrapper.className = "code-block";
      pre.replaceWith(wrapper);
      wrapper.appendChild(pre);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", async () => {
        const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        btn.textContent = (await copyText(code)) ? "Copied" : "Failed";
        window.setTimeout(() => (btn.textContent = "Copy"), 1200);
      });
      wrapper.appendChild(btn);
    });
  }

  // --- Click handling -----------------------------------------------------

  private onBodyClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLElement>("a.wikilink");
    if (link) {
      e.preventDefault();
      const path = link.dataset.path;
      if (path) this.cb.onOpenPath(path);
      else if (link.dataset.target) this.cb.onMissingLink(link.dataset.target);
      return;
    }
    // Any other anchor (external http/mailto link): never let it navigate the
    // webview — that would replace the whole app. Open it outside instead.
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (anchor) {
      e.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) this.cb.onOpenExternal(href);
      return;
    }
    const tag = target.closest<HTMLElement>("span.tag");
    if (tag?.dataset.tag) {
      e.preventDefault();
      this.cb.onTag(tag.dataset.tag);
    }
  }

  // --- Mermaid ------------------------------------------------------------

  /**
   * Render any ```mermaid blocks into SVG. Mermaid is large, so it's imported
   * lazily — only loaded the first time a note actually contains a diagram.
   */
  private async renderMermaid(): Promise<void> {
    const blocks = Array.from(
      this.bodyEl.querySelectorAll<HTMLElement>("code.language-mermaid"),
    );
    if (blocks.length === 0) return;

    const mermaid = (await import("mermaid")).default;
    const theme = document.documentElement.getAttribute("data-theme") ?? "dark";
    const lightThemes = ["light", "retro", "summer"];
    mermaid.initialize({
      startOnLoad: false,
      theme: lightThemes.includes(theme) ? "neutral" : "dark",
      securityLevel: "strict",
    });

    for (const code of blocks) {
      const host = code.closest("pre") ?? code;
      const source = code.textContent ?? "";
      try {
        const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, source);
        const figure = document.createElement("div");
        figure.className = "mermaid-rendered";
        figure.innerHTML = svg;
        host.replaceWith(figure);
      } catch (err) {
        const errBox = document.createElement("div");
        errBox.className = "mermaid-error";
        errBox.textContent = `Mermaid error: ${String(err)}`;
        host.replaceWith(errBox);
      }
    }
  }

  // --- Properties panel ---------------------------------------------------

  private renderProperties(note: RenderedNote): void {
    this.propsEl.replaceChildren();

    if (note.frontmatterError) {
      const warn = document.createElement("div");
      warn.className = "properties-error";
      warn.textContent = `Frontmatter error: ${note.frontmatterError}`;
      this.propsEl.appendChild(warn);
    }

    const fm = note.frontmatter;
    const entries = fm ? Object.entries(fm) : [];
    if (entries.length === 0) {
      this.propsEl.hidden = !note.frontmatterError;
      return;
    }
    this.propsEl.hidden = false;

    for (const [key, value] of entries) {
      const row = document.createElement("div");
      row.className = "property-row";

      const k = document.createElement("span");
      k.className = "property-key";
      k.textContent = key;

      const v = document.createElement("span");
      v.className = "property-value";
      this.fillValue(v, value);

      row.append(k, v);
      this.propsEl.appendChild(row);
    }
  }

  /** Render a single frontmatter value: arrays become chips, else plain text. */
  private fillValue(container: HTMLElement, value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = this.scalar(item);
        container.appendChild(chip);
      }
      if (value.length === 0) container.textContent = "—";
    } else {
      container.textContent = this.scalar(value);
    }
  }

  private scalar(value: unknown): string {
    if (value === null || value === undefined) return "—";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }
}
