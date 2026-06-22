// Settings panel: a modal overlay with a left tab rail (Appearance / Editor /
// Behavior / About) and a scrolling body. Each change updates a working copy of
// the settings and fires `onChange` so the caller can apply it live and persist
// it. Pure DOM (no framework), matching the app's modal style.

import { DEFAULT_SETTINGS, type Settings, type Theme } from "../types";

export interface SettingsCallbacks {
  /** Fired on every change with the full updated settings (apply + persist). */
  onChange: (settings: Settings) => void;
}

/** Version / paths shown in the About tab (gathered by the caller). */
export interface AboutInfo {
  version: string;
  configPath: string | null;
  vaultPath: string | null;
}

type TabId = "appearance" | "editor" | "behavior" | "git" | "about";

const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "behavior", label: "Behavior" },
  { id: "git", label: "Git" },
  { id: "about", label: "About" },
];

/** Representative colors for each theme's preview swatch (from styles.css). */
const THEME_SWATCHES: { value: Theme; label: string; bg: string; accent: string }[] = [
  { value: "dark", label: "Dark", bg: "#1e1e1e", accent: "#4fa3ff" },
  { value: "light", label: "Light", bg: "#ffffff", accent: "#0969da" },
  { value: "grey", label: "Grey", bg: "#1f2123", accent: "#7fa8c9" },
  { value: "forest", label: "Forest", bg: "#14201a", accent: "#6fbf73" },
  { value: "winter", label: "Winter", bg: "#131b2b", accent: "#6fb6ff" },
  { value: "sea", label: "Sea", bg: "#0e2226", accent: "#34c3c3" },
  { value: "retro", label: "Retro", bg: "#f4ecd8", accent: "#b85c38" },
  { value: "summer", label: "Summer", bg: "#fffdf5", accent: "#e8559b" },
  { value: "dracula", label: "Dracula", bg: "#282a36", accent: "#bd93f9" },
  { value: "nord", label: "Nord", bg: "#2e3440", accent: "#88c0d0" },
  { value: "gruvbox", label: "Gruvbox", bg: "#282828", accent: "#fe8019" },
  { value: "mocha", label: "Mocha", bg: "#2b2420", accent: "#d2a679" },
  { value: "neon", label: "Neon", bg: "#0d0f1a", accent: "#00e5ff" },
  { value: "rose", label: "Rosé", bg: "#232136", accent: "#ea9a97" },
];

export class SettingsPanel {
  private overlay: HTMLDivElement;
  private nav: HTMLDivElement;
  private body: HTMLDivElement;
  private settings: Settings | null = null;
  private about: AboutInfo = { version: "—", configPath: null, vaultPath: null };
  private activeTab: TabId = "appearance";

  constructor(mount: HTMLElement, private cb: SettingsCallbacks) {
    this.overlay = document.createElement("div");
    this.overlay.className = "settings-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="settings-card">
        <header class="settings-header">
          <span class="settings-title">Settings</span>
          <button class="settings-close" title="Close (Esc)" aria-label="Close">✕</button>
        </header>
        <div class="settings-main">
          <nav class="settings-nav"></nav>
          <div class="settings-body"></div>
        </div>
        <footer class="settings-footer">
          <button class="settings-reset">Reset to defaults</button>
        </footer>
      </div>
    `;
    mount.appendChild(this.overlay);
    this.nav = this.overlay.querySelector(".settings-nav")!;
    this.body = this.overlay.querySelector(".settings-body")!;

    this.overlay.querySelector(".settings-close")!.addEventListener("click", () => this.close());
    this.overlay.querySelector(".settings-reset")!.addEventListener("click", () => this.reset());
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.overlay.hidden) this.close();
    });
  }

  open(settings: Settings, about: AboutInfo): void {
    this.settings = { ...settings };
    this.about = about;
    this.render();
    this.overlay.hidden = false;
  }

  close(): void {
    this.overlay.hidden = true;
  }

  // --- Rendering ------------------------------------------------------------

  private render(): void {
    this.renderNav();
    this.renderBody();
  }

  private renderNav(): void {
    this.nav.replaceChildren();
    for (const tab of TABS) {
      const btn = document.createElement("button");
      btn.className = "settings-tab";
      btn.textContent = tab.label;
      if (tab.id === this.activeTab) btn.classList.add("active");
      btn.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.render();
      });
      this.nav.appendChild(btn);
    }
  }

  private renderBody(): void {
    this.body.replaceChildren();
    if (!this.settings) return;
    if (this.activeTab === "appearance") this.renderAppearance();
    else if (this.activeTab === "editor") this.renderEditor();
    else if (this.activeTab === "behavior") this.renderBehavior();
    else if (this.activeTab === "git") this.renderGit();
    else this.renderAbout();
    this.body.scrollTop = 0;
  }

  private renderAppearance(): void {
    const s = this.settings!;

    this.section("Theme", [this.themeSwatches(s.theme)]);

    this.section("Accent color", [
      this.colorRow(
        "Custom accent",
        s.accentColor,
        "Override the theme's accent color. Clear to use the theme default.",
      ),
    ]);

    this.section("Interface", [
      this.select("Interface size", String(s.uiScale), [
        { value: "0.9", label: "Small (90%)" },
        { value: "1", label: "Default (100%)" },
        { value: "1.1", label: "Large (110%)" },
        { value: "1.25", label: "Larger (125%)" },
      ], (v) => this.update("uiScale", Number(v)), "Zoom the whole interface up or down."),
    ]);
  }

  private renderEditor(): void {
    const s = this.settings!;

    this.section("Typography", [
      this.number("Font size", s.editorFontSize, { min: 10, max: 28, step: 1, unit: "px" },
        (v) => this.update("editorFontSize", v), "Size of the editor text."),
      this.select("Font family", s.editorFontFamily, [
        { value: "mono", label: "Monospace" },
        { value: "sans", label: "Sans-serif" },
        { value: "serif", label: "Serif" },
      ], (v) => this.update("editorFontFamily", v as Settings["editorFontFamily"]),
        "Typeface used for the editor (preview is unaffected)."),
      this.number("Line height", s.editorLineHeight, { min: 1.2, max: 2.4, step: 0.1 },
        (v) => this.update("editorLineHeight", v), "Vertical spacing between lines."),
    ]);

    this.section("Layout", [
      this.checkbox("Readable line width", s.readableLineWidth,
        (v) => this.update("readableLineWidth", v),
        "Cap the editor and preview to a centered, comfortable column."),
      this.number("Column width", s.contentWidth, { min: 480, max: 1200, step: 20, unit: "px" },
        (v) => this.update("contentWidth", v),
        "Width of that column when readable line width is on."),
      this.checkbox("Wrap long lines", s.lineWrap, (v) => this.update("lineWrap", v),
        "Soft-wrap lines that exceed the editor width."),
      this.checkbox("Show line numbers", s.lineNumbers, (v) => this.update("lineNumbers", v),
        "Display a line-number gutter."),
    ]);

    this.section("Editing", [
      this.checkbox("Auto-pair brackets", s.autoPair, (v) => this.update("autoPair", v),
        "Automatically close brackets and quotes as you type."),
      this.checkbox("Spellcheck", s.spellcheck, (v) => this.update("spellcheck", v),
        "Underline misspelled words using the system dictionary."),
      this.checkbox("Highlight active line", s.highlightActiveLine,
        (v) => this.update("highlightActiveLine", v), "Shade the line the cursor is on."),
      this.checkbox("Indent with tabs", s.indentWithTabs, (v) => this.update("indentWithTabs", v),
        "Tab inserts a real tab character instead of spaces."),
      this.select("Tab size", String(s.tabSize), [
        { value: "2", label: "2 spaces" },
        { value: "4", label: "4 spaces" },
        { value: "8", label: "8 spaces" },
      ], (v) => this.update("tabSize", Number(v)), "Indent width (spaces, and how tabs render)."),
    ]);
  }

  private renderBehavior(): void {
    const s = this.settings!;
    this.section("Notes", [
      this.select("Open notes in", s.defaultView, [
        { value: "edit", label: "Edit mode" },
        { value: "preview", label: "Preview mode" },
      ], (v) => this.update("defaultView", v as Settings["defaultView"]),
        "Which view a note opens in."),
      this.select("New notes go to", s.newNoteLocation, [
        { value: "current", label: "Current folder" },
        { value: "root", label: "Vault root" },
      ], (v) => this.update("newNoteLocation", v as Settings["newNoteLocation"]),
        "Where a freshly-created note is placed."),
    ]);
    this.section("Saving", [
      this.number("Autosave delay", s.autosaveMs, { min: 100, max: 5000, step: 100, unit: "ms" },
        (v) => this.update("autosaveMs", v), "How long after you stop typing edits are written."),
      this.checkbox("Confirm before delete", s.confirmDelete, (v) => this.update("confirmDelete", v),
        "Ask before moving a note or folder to the Trash."),
    ]);
    this.section("Files & startup", [
      this.checkbox("Reopen last vault on launch", s.reopenLastVault,
        (v) => this.update("reopenLastVault", v), "Automatically open the vault you used last."),
      this.checkbox("Show file extensions", s.showMdExtension,
        (v) => this.update("showMdExtension", v), "Show .md in the file tree (hidden by default)."),
    ]);
  }

  private renderGit(): void {
    const s = this.settings!;
    this.section("Versioning", [
      this.checkbox("Enable Git", s.gitEnabled, (v) => this.update("gitEnabled", v),
        "Show the Git panel in the sidebar and turn on versioning for vaults."),
      this.number("Auto-commit (minutes)", s.gitAutoCommitMinutes, { min: 0, max: 240, step: 1 },
        (v) => this.update("gitAutoCommitMinutes", v),
        "Automatically commit changes on this interval. 0 turns auto-commit off."),
      this.checkbox("Confirm before discard", s.confirmDiscard, (v) => this.update("confirmDiscard", v),
        "Ask before discarding all changes since the last commit."),
    ]);
  }

  private renderAbout(): void {
    const section = document.createElement("div");
    section.className = "settings-section";
    const heading = document.createElement("div");
    heading.className = "settings-section-title";
    heading.textContent = "About";
    section.appendChild(heading);

    const dl = document.createElement("dl");
    dl.className = "about-list";
    const add = (term: string, value: string | null) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value ?? "—";
      if (!value) dd.classList.add("about-empty");
      dl.append(dt, dd);
    };
    add("App", "CreWrite");
    add("Version", this.about.version);
    add("Open vault", this.about.vaultPath);
    add("Config file", this.about.configPath);
    section.appendChild(dl);
    this.body.appendChild(section);
  }

  // --- State ----------------------------------------------------------------

  /** Merge a change, then notify the caller with the full settings. */
  private update<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (!this.settings) return;
    this.settings = { ...this.settings, [key]: value };
    this.cb.onChange(this.settings);
  }

  private reset(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    this.cb.onChange(this.settings);
    this.renderBody();
  }

  // --- Control builders -----------------------------------------------------

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

  /** A labelled row: stacked label + help on the left, control on the right. */
  private row(label: string, control: HTMLElement, help?: string): HTMLElement {
    const row = document.createElement("label");
    row.className = "setting-row";
    const text = document.createElement("span");
    text.className = "setting-text";
    const name = document.createElement("span");
    name.className = "setting-label";
    name.textContent = label;
    text.appendChild(name);
    if (help) {
      const hint = document.createElement("span");
      hint.className = "setting-help";
      hint.textContent = help;
      text.appendChild(hint);
    }
    row.append(text, control);
    return row;
  }

  private themeSwatches(active: Theme): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "theme-swatches";
    for (const sw of THEME_SWATCHES) {
      const btn = document.createElement("button");
      btn.className = "theme-swatch";
      btn.type = "button";
      if (sw.value === active) btn.classList.add("selected");
      btn.title = sw.label;

      const chip = document.createElement("span");
      chip.className = "swatch-chip";
      chip.style.background = sw.bg;
      const dot = document.createElement("span");
      dot.className = "swatch-dot";
      dot.style.background = sw.accent;
      chip.appendChild(dot);

      const name = document.createElement("span");
      name.className = "swatch-label";
      name.textContent = sw.label;

      btn.append(chip, name);
      btn.addEventListener("click", () => {
        this.update("theme", sw.value);
        this.renderBody(); // move the selected outline
      });
      grid.appendChild(btn);
    }
    return grid;
  }

  private colorRow(label: string, value: string | null, help: string): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "setting-color";

    const input = document.createElement("input");
    input.type = "color";
    input.className = "setting-color-input";
    // When no custom accent is set, seed the picker with the theme's accent.
    input.value = value ?? readThemeAccent();

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "setting-color-clear";
    clear.textContent = value ? "Clear" : "Default";
    clear.disabled = !value;

    input.addEventListener("input", () => {
      this.update("accentColor", input.value);
      clear.disabled = false;
      clear.textContent = "Clear";
    });
    clear.addEventListener("click", (e) => {
      e.preventDefault();
      this.update("accentColor", null);
      this.renderBody(); // reseed the picker from the theme + reset the button
    });

    wrap.append(input, clear);
    return this.row(label, wrap, help);
  }

  private select(
    label: string,
    value: string,
    options: { value: string; label: string }[],
    onChange: (value: string) => void,
    help?: string,
  ): HTMLElement {
    const sel = document.createElement("select");
    sel.className = "setting-control";
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    return this.row(label, sel, help);
  }

  private checkbox(
    label: string,
    value: boolean,
    onChange: (value: boolean) => void,
    help?: string,
  ): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "setting-control setting-checkbox";
    box.checked = value;
    box.addEventListener("change", () => onChange(box.checked));
    return this.row(label, box, help);
  }

  private number(
    label: string,
    value: number,
    opts: { min: number; max: number; step: number; unit?: string },
    onChange: (value: number) => void,
    help?: string,
  ): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "setting-number";
    const input = document.createElement("input");
    input.type = "number";
    input.className = "setting-control";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.value = String(value);
    input.addEventListener("change", () => {
      let n = Number(input.value);
      if (Number.isNaN(n)) n = value;
      n = Math.max(opts.min, Math.min(opts.max, n));
      // Round to the step's precision (so 1.7 doesn't become 1.7000000000002).
      n = Math.round(n / opts.step) * opts.step;
      n = Math.round(n * 1000) / 1000;
      input.value = String(n);
      onChange(n);
    });
    wrap.appendChild(input);
    if (opts.unit) {
      const unit = document.createElement("span");
      unit.className = "setting-unit";
      unit.textContent = opts.unit;
      wrap.appendChild(unit);
    }
    return this.row(label, wrap, help);
  }
}

/** The theme's current accent as a #rrggbb hex (for seeding the color picker). */
function readThemeAccent(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : "#4fa3ff";
}
