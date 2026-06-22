// Editor pane: CodeMirror 6 for raw Markdown editing.
//
// Public surface (setContent / getContent / clear / focus + callbacks) matches
// the old <textarea> editor, so the rest of the app (autosave, dirty tracking,
// flush-on-blur, inline-title rename) is unchanged. Features: markdown syntax
// highlighting, a theme matching the app, [[wikilink]] / #tag autocomplete,
// ⌘B/⌘I shortcuts, ⌘F find/replace, line wrapping, undo, bracket niceties.

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  bracketMatching,
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
  type KeyBinding,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export interface EditorCallbacks {
  /** Fired immediately on every user edit — used to mark the note dirty. */
  onInput: () => void;
  /** Fired (debounced) when the text changes — used for autosave. */
  onChange: (content: string) => void;
  /** Fired on ⌘/Ctrl+S — used for explicit save. */
  onSaveShortcut: () => void;
  /** Note names to suggest after `[[`. */
  getLinkTargets: () => string[];
  /** Tags to suggest after `#`. */
  getTags: () => string[];
}

// Theme matching the app's dark palette (CSS variables resolve at render time).
const appTheme = EditorView.theme(
  {
    "&": { color: "var(--text)", backgroundColor: "var(--bg)", height: "100%" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": {
      fontFamily: "var(--editor-font, var(--font-mono))",
      fontSize: "var(--editor-font-size, 15px)",
      lineHeight: "var(--editor-line-height, 1.7)",
      padding: "24px 32px",
      caretColor: "var(--accent)",
    },
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--editor-font, var(--font-mono))" },
    ".cm-gutters": {
      backgroundColor: "var(--bg)",
      color: "var(--text-dim)",
      border: "none",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)" },
    ".cm-activeLine": { backgroundColor: "var(--active-line)" },
    ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 20%, transparent)", outline: "none" },
    ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)" },
    // Search panel + autocomplete tooltip.
    ".cm-panels": { backgroundColor: "var(--bg-sidebar)", color: "var(--text)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 50%, transparent)" },
    ".cm-textfield": {
      backgroundColor: "var(--bg)",
      border: "1px solid var(--border)",
      color: "var(--text)",
    },
    ".cm-button": {
      backgroundColor: "var(--bg-hover)",
      border: "1px solid var(--border)",
      color: "var(--text)",
      borderRadius: "4px",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-sidebar)",
      border: "1px solid var(--border)",
      color: "var(--text)",
    },
    ".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--bg-active)",
      color: "var(--text)",
    },
  },
  { dark: true },
);

// Markdown token colors.
const appHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--accent)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "var(--accent-text)" },
  { tag: t.quote, color: "var(--text-dim)" },
  { tag: t.list, color: "var(--accent)" },
  { tag: t.contentSeparator, color: "var(--text-dim)" },
  // Dim the markup characters themselves (#, **, -, > …).
  { tag: [t.processingInstruction, t.meta, t.punctuation], color: "var(--text-dim)" },
]);

/** Completion source for `[[wikilinks]]`. */
function wikilinkSource(getLinkTargets: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^\]\n]*/);
    if (!before) return null;
    const from = before.from + 2; // after the "[["
    const options: Completion[] = getLinkTargets().map((name) => ({
      label: name,
      type: "class",
      apply: (view, _completion, applyFrom, applyTo) => {
        // Don't duplicate a "]]" that close-brackets already inserted.
        const hasClosing = view.state.sliceDoc(applyTo, applyTo + 2) === "]]";
        view.dispatch({
          changes: { from: applyFrom, to: applyTo, insert: hasClosing ? name : `${name}]]` },
          selection: { anchor: applyFrom + name.length + 2 },
        });
      },
    }));
    return { from, options, validFor: /[^\]\n]*/ };
  };
}

/** Completion source for `#tags` (requires `#` + at least one char). */
function tagSource(getTags: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/#[\w/-]+/);
    if (!before) return null;
    // Must follow a boundary (not mid-word like "C#").
    const prev = before.from > 0 ? context.state.sliceDoc(before.from - 1, before.from) : "";
    if (prev && !/\s/.test(prev)) return null;
    const from = before.from + 1; // after the "#"
    const options: Completion[] = getTags().map((tag) => ({ label: tag, type: "keyword" }));
    return { from, options, validFor: /[\w/-]*/ };
  };
}

/** Wrap each selection in `marker` (e.g. `**` for bold), keeping it selected. */
function toggleWrap(marker: string) {
  return (view: EditorView): boolean => {
    view.dispatch(
      view.state.changeByRange((range) => ({
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      })),
    );
    return true;
  };
}

export class Editor {
  private view: EditorView;
  private editable = new Compartment();
  private wrap = new Compartment();
  private spell = new Compartment();
  private tab = new Compartment();
  private pairs = new Compartment();
  private gutter = new Compartment();
  private activeLine = new Compartment();
  private loading = false;
  private debounceTimer: number | null = null;
  private debounceMs = 600;

  constructor(mount: HTMLElement, private cb: EditorCallbacks) {
    const markdownShortcuts: KeyBinding[] = [
      { key: "Mod-b", run: toggleWrap("**") },
      { key: "Mod-i", run: toggleWrap("*") },
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          this.cancelDebounce();
          this.cb.onSaveShortcut();
          return true;
        },
      },
    ];

    this.view = new EditorView({
      parent: mount,
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        this.activeLine.of(highlightActiveLine()),
        bracketMatching(),
        highlightSelectionMatches(),
        this.gutter.of([]),
        this.pairs.of(closeBrackets()),
        this.wrap.of(EditorView.lineWrapping),
        this.spell.of(EditorView.contentAttributes.of({ spellcheck: "false" })),
        this.tab.of([EditorState.tabSize.of(4), indentUnit.of("    ")]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(appHighlight),
        appTheme,
        placeholder("Start writing…"),
        autocompletion({
          override: [wikilinkSource(cb.getLinkTargets), tagSource(cb.getTags)],
        }),
        this.editable.of(EditorView.editable.of(false)),
        keymap.of([
          ...markdownShortcuts,
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !this.loading) {
            this.cb.onInput();
            this.scheduleChange();
          }
        }),
      ],
    });
  }

  /** Load content for a note and enable editing. */
  setContent(content: string): void {
    this.loading = true;
    this.cancelDebounce();
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: content },
      selection: { anchor: 0 },
      effects: this.editable.reconfigure(EditorView.editable.of(true)),
    });
    this.loading = false;
  }

  /** Clear and disable the editor (no note open). */
  clear(): void {
    this.loading = true;
    this.cancelDebounce();
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: "" },
      effects: this.editable.reconfigure(EditorView.editable.of(false)),
    });
    this.loading = false;
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  // --- Live-applied settings ------------------------------------------------

  setLineWrap(on: boolean): void {
    this.view.dispatch({
      effects: this.wrap.reconfigure(on ? EditorView.lineWrapping : []),
    });
  }

  setSpellcheck(on: boolean): void {
    this.view.dispatch({
      effects: this.spell.reconfigure(
        EditorView.contentAttributes.of({ spellcheck: on ? "true" : "false" }),
      ),
    });
  }

  setLineNumbers(on: boolean): void {
    this.view.dispatch({
      effects: this.gutter.reconfigure(on ? lineNumbers() : []),
    });
  }

  setAutoPair(on: boolean): void {
    this.view.dispatch({
      effects: this.pairs.reconfigure(on ? closeBrackets() : []),
    });
  }

  setActiveLineHighlight(on: boolean): void {
    this.view.dispatch({
      effects: this.activeLine.reconfigure(on ? highlightActiveLine() : []),
    });
  }

  /** Set indent width and whether Tab inserts a real tab or `size` spaces. */
  setIndent(n: number, useTabs: boolean): void {
    const size = Math.max(1, Math.min(8, Math.round(n)));
    this.view.dispatch({
      effects: this.tab.reconfigure([
        EditorState.tabSize.of(size),
        indentUnit.of(useTabs ? "\t" : " ".repeat(size)),
      ]),
    });
  }

  setAutosaveDelay(ms: number): void {
    this.debounceMs = Math.max(0, ms);
  }

  focus(): void {
    this.view.focus();
  }

  private scheduleChange(): void {
    this.cancelDebounce();
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.cb.onChange(this.getContent());
    }, this.debounceMs);
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
