// Export popup: choose a format (PDF / Word) and what to export (current note,
// a folder, or the whole vault), then hand the options back to the caller. The
// caller decides the engine (Pandoc vs the built-in print path). Reuses the
// app's modal styling.

export interface ExportContext {
  activePath: string | null;
  selectedDir: string; // "" = vault root
}

/** Initial format/combine/strip values (the user's saved Export settings). */
export interface ExportDefaults {
  format: "pdf" | "docx";
  combine: boolean;
  stripFrontmatter: boolean;
}

export interface ExportOptions {
  format: "pdf" | "docx";
  scope: "note" | "folder" | "vault";
  path: string; // note path, folder path, or "" for the vault
  combine: boolean;
  stripFrontmatter: boolean;
}

export interface ExportCallbacks {
  onExport: (opts: ExportOptions) => void;
}

export class ExportPanel {
  private overlay: HTMLDivElement;
  private body: HTMLDivElement;
  private ctx: ExportContext | null = null;
  private state = {
    format: "pdf" as "pdf" | "docx",
    scope: "note" as "note" | "folder" | "vault",
    combine: true,
    stripFrontmatter: false,
  };

  constructor(mount: HTMLElement, private cb: ExportCallbacks) {
    this.overlay = document.createElement("div");
    // Reuse the settings modal styling; the extra class disambiguates it.
    this.overlay.className = "settings-overlay export-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="settings-card">
        <header class="settings-header">
          <span class="settings-title">Export</span>
          <button class="settings-close" title="Close (Esc)">✕</button>
        </header>
        <div class="settings-body"></div>
      </div>
    `;
    mount.appendChild(this.overlay);
    this.body = this.overlay.querySelector(".settings-body")!;

    this.overlay.querySelector(".settings-close")!.addEventListener("click", () => this.close());
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.overlay.hidden) this.close();
    });
  }

  open(ctx: ExportContext, defaults?: ExportDefaults): void {
    this.ctx = ctx;
    if (defaults) {
      this.state.format = defaults.format;
      this.state.combine = defaults.combine;
      this.state.stripFrontmatter = defaults.stripFrontmatter;
    }
    this.state.scope = ctx.activePath ? "note" : ctx.selectedDir ? "folder" : "vault";
    this.render();
    this.overlay.hidden = false;
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.state;
    this.body.replaceChildren();

    // Format (both built-in — always available).
    this.section("Format", [
      this.select(
        "File type",
        s.format,
        [
          { value: "pdf", label: "PDF" },
          { value: "docx", label: "Word (.docx)" },
        ],
        (v) => {
          s.format = v as "pdf" | "docx";
          this.render();
        },
      ),
      this.info(
        s.format === "pdf"
          ? "Mermaid diagrams are embedded as images."
          : "Mermaid diagrams aren’t embedded in Word — they export as their source text. Choose PDF to embed them as images.",
      ),
    ]);

    // Scope.
    const scopeOpts: { value: string; label: string; disabled?: boolean }[] = [];
    if (ctx.activePath) scopeOpts.push({ value: "note", label: "Current note" });
    if (ctx.selectedDir) scopeOpts.push({ value: "folder", label: `Folder: ${ctx.selectedDir}` });
    scopeOpts.push({ value: "vault", label: "Whole vault" });
    this.section("What to export", [
      this.select("Scope", s.scope, scopeOpts, (v) => {
        s.scope = v as typeof s.scope;
        this.render();
      }),
      ...(s.scope === "note"
        ? []
        : [
            this.select(
              "Output",
              s.combine ? "combine" : "separate",
              [
                { value: "combine", label: "Combine into one file" },
                { value: "separate", label: "One file per note" },
              ],
              (v) => {
                s.combine = v === "combine";
              },
            ),
          ]),
      this.checkbox("Strip frontmatter", s.stripFrontmatter, (v) => {
        s.stripFrontmatter = v;
      }),
    ]);

    // Actions.
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "modal-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    const go = document.createElement("button");
    go.className = "modal-btn primary";
    go.textContent = "Export";
    go.addEventListener("click", () => this.doExport());
    actions.append(cancel, go);
    this.body.appendChild(actions);
  }

  private doExport(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.state;
    const path = s.scope === "note" ? (ctx.activePath ?? "") : s.scope === "folder" ? ctx.selectedDir : "";
    this.cb.onExport({
      format: s.format,
      scope: s.scope,
      path,
      combine: s.scope === "note" ? true : s.combine,
      stripFrontmatter: s.stripFrontmatter,
    });
    this.close();
  }

  // --- Control builders (reuse the settings panel's styles) ----------------

  private section(title: string, rows: HTMLElement[]): void {
    const section = document.createElement("div");
    section.className = "settings-section";
    const heading = document.createElement("div");
    heading.className = "settings-section-title";
    heading.textContent = title;
    section.appendChild(heading);
    for (const row of rows) section.appendChild(row);
    this.body.appendChild(section);
  }

  /** A small dim informational note (e.g. the Mermaid/PDF caveat). */
  private info(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "export-info";
    el.textContent = `ⓘ  ${text}`;
    return el;
  }

  private row(label: string, control: HTMLElement): HTMLElement {
    const row = document.createElement("label");
    row.className = "setting-row";
    const text = document.createElement("span");
    text.className = "setting-label";
    text.textContent = label;
    row.append(text, control);
    return row;
  }

  private select(
    label: string,
    value: string,
    options: { value: string; label: string; disabled?: boolean }[],
    onChange: (value: string) => void,
  ): HTMLElement {
    const sel = document.createElement("select");
    sel.className = "setting-control";
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.disabled) o.disabled = true;
      if (opt.value === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    return this.row(label, sel);
  }

  private checkbox(label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "setting-control setting-checkbox";
    box.checked = value;
    box.addEventListener("change", () => onChange(box.checked));
    return this.row(label, box);
  }
}
