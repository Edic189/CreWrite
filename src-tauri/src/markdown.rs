//! Markdown rendering + link/tag extraction (Phases 2–3).
//!
//! A note is split into optional YAML frontmatter and a Markdown body. We then
//! transform Obsidian-style constructs **outside code** by pre-scanning the raw
//! body (`pulldown-cmark` would otherwise tear `[[..]]` apart trying to parse
//! the inner `[..]` as a reference link):
//!   - `[[target]]`, `[[target|alias]]`, `[[target#heading]]` → `<a>` anchors,
//!     resolved against the vault index (existing vs. missing).
//!   - `#tag` → `<span class="tag">` chips.
//! The transformed body is parsed as GFM and the resulting HTML is **sanitized**
//! (`ammonia`) before reaching the webview — notes are untrusted input and the
//! webview has IPC access.
//!
//! The same code-aware scan ([`scan_non_code`]) powers [`extract`], which feeds
//! the vault index. This module is Tauri-free and unit-tested.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use ammonia::Builder;
use pulldown_cmark::{html, Options, Parser};
use regex::Regex;
use serde::Serialize;

/// One wikilink discovered while rendering, with its resolution result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    /// The raw target text (alias/heading stripped), e.g. "Folder/Note".
    pub target: String,
    /// Resolved vault-relative path, or `None` if no matching note exists.
    pub path: Option<String>,
}

/// Result of rendering a note's raw text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedNote {
    /// Sanitized HTML for the body (frontmatter excluded).
    pub html: String,
    /// Parsed frontmatter as a generic JSON value, if a valid block was found.
    pub frontmatter: Option<serde_json::Value>,
    /// Human-readable YAML parse error, if the frontmatter was malformed.
    pub frontmatter_error: Option<String>,
    /// Wikilinks found in the body (in document order, de-duplicated).
    pub links: Vec<ResolvedLink>,
    /// Tags found in the body (sorted, de-duplicated, without the leading `#`).
    pub tags: Vec<String>,
}

/// Lightweight extraction for the vault index (no HTML built).
#[derive(Debug, Clone, Default)]
pub struct Extracted {
    /// Frontmatter `title`, if present.
    pub title: Option<String>,
    /// Raw wikilink targets (alias/heading stripped).
    pub links: Vec<String>,
    /// Tags from the body and frontmatter (de-duplicated).
    pub tags: Vec<String>,
}

// `[[ ... ]]` — inner text captured, brackets/newlines excluded.
static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\[\]\n]+)\]\]").expect("valid wikilink regex"));

// A `#tag` preceded by start-of-segment or a boundary char. Group 1 is the
// leading boundary (preserved on render), group 2 is the tag incl. `#`.
static TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[\s(])(#[\p{L}\p{N}_/\-]+)").expect("valid tag regex"));

// A GFM task-list item: a bullet/ordered marker then `[ ]`/`[x]`/`[X]`.
// Group 1 is the single state character (toggled in place).
static TASK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]").expect("valid task regex")
});

/// GFM feature set we enable.
fn gfm_options() -> Options {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options
}

/// Render raw note text into sanitized HTML, parsed frontmatter, and the
/// links/tags discovered. `resolve` maps a raw wikilink target to a note path.
pub fn render(content: &str, resolve: impl Fn(&str) -> Option<String>) -> RenderedNote {
    let (frontmatter, frontmatter_error, body) = parse_frontmatter(content);

    let mut links: Vec<ResolvedLink> = Vec::new();
    let mut seen_links: BTreeSet<String> = BTreeSet::new();
    let mut tags: BTreeSet<String> = BTreeSet::new();

    // Pre-transform wikilinks/tags into inline HTML (outside code), then let
    // pulldown-cmark parse the rest as Markdown and pass our HTML through.
    let transformed = scan_non_code(body, |chunk| {
        transform_chunk(chunk, &resolve, &mut links, &mut seen_links, &mut tags)
    });

    let mut raw_html = String::new();
    html::push_html(&mut raw_html, Parser::new_ext(&transformed, gfm_options()));

    RenderedNote {
        html: sanitize(&raw_html),
        frontmatter,
        frontmatter_error,
        links,
        tags: tags.into_iter().collect(),
    }
}

/// Extract links/tags/title for the index, without building HTML.
pub fn extract(content: &str) -> Extracted {
    let (frontmatter, _err, body) = parse_frontmatter(content);

    let mut links: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut tags: BTreeSet<String> = BTreeSet::new();

    scan_non_code(body, |chunk| {
        for caps in WIKILINK_RE.captures_iter(chunk) {
            let (target, _) = clean_wikilink(&caps[1]);
            if !target.is_empty() && seen.insert(target.clone()) {
                links.push(target);
            }
        }
        for caps in TAG_RE.captures_iter(chunk) {
            let name = &caps[2][1..]; // drop leading '#'
            if is_valid_tag(name) {
                tags.insert(name.to_string());
            }
        }
        String::new() // extraction doesn't need the rebuilt text
    });

    let mut title = None;
    if let Some(obj) = frontmatter.as_ref().and_then(|v| v.as_object()) {
        title = obj.get("title").and_then(|v| v.as_str()).map(str::to_string);
        if let Some(tag_value) = obj.get("tags").or_else(|| obj.get("tag")) {
            collect_frontmatter_tags(tag_value, &mut tags);
        }
    }

    Extracted {
        title,
        links,
        tags: tags.into_iter().collect(),
    }
}

/// Toggle the `index`-th task-list checkbox (0-based, document order) in
/// `content`, matching the order of the rendered `<input>` checkboxes.
/// Returns the updated content, or `None` if there is no task at that index.
///
/// Frontmatter is left untouched and checkboxes inside fenced code blocks are
/// skipped — exactly the items that *don't* render as checkboxes — so the index
/// stays aligned with what the user clicked.
pub fn toggle_task(content: &str, index: usize) -> Option<String> {
    let (_, body) = split_frontmatter(content);
    let prefix_len = content.len() - body.len();
    let new_body = toggle_task_in_body(body, index)?;

    let mut out = String::with_capacity(content.len());
    out.push_str(&content[..prefix_len]);
    out.push_str(&new_body);
    Some(out)
}

fn toggle_task_in_body(body: &str, target: usize) -> Option<String> {
    let mut out = String::with_capacity(body.len());
    let mut fence: Option<(char, usize)> = None;
    let mut count = 0usize;
    let mut toggled = false;

    for line in body.split_inclusive('\n') {
        if toggled {
            out.push_str(line);
            continue;
        }
        let marker = fence_marker(line.trim_start());
        match fence {
            Some((fc, flen)) => {
                out.push_str(line);
                if let Some((c, len)) = marker {
                    if c == fc && len >= flen {
                        fence = None;
                    }
                }
            }
            None => {
                if let Some((c, len)) = marker {
                    fence = Some((c, len));
                    out.push_str(line);
                } else if let Some(caps) = TASK_RE.captures(line) {
                    let state = caps.get(1).expect("state group");
                    if count == target {
                        let new_state = if &line[state.start()..state.end()] == " " {
                            "x"
                        } else {
                            " "
                        };
                        out.push_str(&line[..state.start()]);
                        out.push_str(new_state);
                        out.push_str(&line[state.end()..]);
                        toggled = true;
                    } else {
                        out.push_str(line);
                    }
                    count += 1;
                } else {
                    out.push_str(line);
                }
            }
        }
    }

    toggled.then_some(out)
}

/// Walk `body`, calling `on_text` with each run of text that lies **outside**
/// code (fenced blocks and inline spans), and passing code through verbatim.
/// Returns the rebuilt string (`on_text`'s outputs spliced back in).
fn scan_non_code<F: FnMut(&str) -> String>(body: &str, mut on_text: F) -> String {
    let mut out = String::with_capacity(body.len());
    let mut fence: Option<(char, usize)> = None; // (fence char, min length) when open

    for line in body.split_inclusive('\n') {
        let marker = fence_marker(line.trim_start());
        match fence {
            // Inside a fenced code block: emit verbatim, watch for the closer.
            Some((fc, flen)) => {
                out.push_str(line);
                if let Some((c, len)) = marker {
                    if c == fc && len >= flen {
                        fence = None;
                    }
                }
            }
            None => match marker {
                // Opening fence: emit verbatim, enter code mode.
                Some((c, len)) => {
                    out.push_str(line);
                    fence = Some((c, len));
                }
                // Normal line: handle inline code, transform the rest.
                None => out.push_str(&process_inline(line, &mut on_text)),
            },
        }
    }
    out
}

/// If `trimmed` (a left-trimmed line) opens/closes a code fence, return the
/// fence character and its run length.
fn fence_marker(trimmed: &str) -> Option<(char, usize)> {
    for marker in ['`', '~'] {
        let len = trimmed.chars().take_while(|&c| c == marker).count();
        if len >= 3 {
            return Some((marker, len));
        }
    }
    None
}

/// Split a single line around inline code spans, transforming the non-code
/// parts via `on_text` and emitting code spans verbatim.
fn process_inline<F: FnMut(&str) -> String>(line: &str, on_text: &mut F) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    let mut text_start = 0;

    while i < line.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let run_start = i;
        while i < line.len() && bytes[i] == b'`' {
            i += 1;
        }
        let run_len = i - run_start;
        // A code span closes on a backtick run of the *same* length.
        if let Some(close_end) = find_backtick_run(line, i, run_len) {
            out.push_str(&on_text(&line[text_start..run_start]));
            out.push_str(&line[run_start..close_end]); // verbatim code span
            i = close_end;
            text_start = i;
        }
        // No closer: the backticks are literal; leave them in the pending text.
    }
    out.push_str(&on_text(&line[text_start..]));
    out
}

/// Find the end index of the next run of exactly `n` backticks at/after `from`.
fn find_backtick_run(line: &str, from: usize, n: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = from;
    while i < line.len() {
        if bytes[i] == b'`' {
            let start = i;
            while i < line.len() && bytes[i] == b'`' {
                i += 1;
            }
            if i - start == n {
                return Some(i);
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Transform one out-of-code chunk: replace wikilinks/tags with inline HTML,
/// leaving the rest as raw Markdown for pulldown-cmark to handle.
fn transform_chunk(
    chunk: &str,
    resolve: &impl Fn(&str) -> Option<String>,
    links: &mut Vec<ResolvedLink>,
    seen_links: &mut BTreeSet<String>,
    tags: &mut BTreeSet<String>,
) -> String {
    let mut out = String::with_capacity(chunk.len());
    let mut last = 0;
    for caps in WIKILINK_RE.captures_iter(chunk) {
        let m = caps.get(0).expect("group 0");
        out.push_str(&transform_tags(&chunk[last..m.start()], tags)); // tags in the gap
        out.push_str(&wikilink_html(&caps[1], resolve, links, seen_links));
        last = m.end();
    }
    out.push_str(&transform_tags(&chunk[last..], tags));
    out
}

/// Replace `#tag` occurrences with chip spans; leave other text as raw Markdown.
fn transform_tags(text: &str, tags: &mut BTreeSet<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for caps in TAG_RE.captures_iter(text) {
        let whole = caps.get(0).expect("group 0");
        let boundary = caps.get(1).expect("group 1").as_str();
        let tag_with_hash = caps.get(2).expect("group 2").as_str();
        let name = &tag_with_hash[1..];

        out.push_str(&text[last..whole.start()]);
        out.push_str(boundary);
        if is_valid_tag(name) {
            tags.insert(name.to_string());
            out.push_str(&format!(
                "<span class=\"tag\" data-tag=\"{}\">{}</span>",
                escape_html(name),
                escape_html(tag_with_hash),
            ));
        } else {
            out.push_str(tag_with_hash);
        }
        last = whole.end();
    }
    out.push_str(&text[last..]);
    out
}

/// Build an `<a>` for a wikilink, recording its resolution.
fn wikilink_html(
    inner: &str,
    resolve: &impl Fn(&str) -> Option<String>,
    links: &mut Vec<ResolvedLink>,
    seen_links: &mut BTreeSet<String>,
) -> String {
    let (target, label) = clean_wikilink(inner);
    if target.is_empty() {
        // e.g. `[[#heading]]` (intra-note) — show literally, wrapped so
        // pulldown-cmark doesn't try to re-parse the brackets.
        return format!("<span>{}</span>", escape_html(&format!("[[{inner}]]")));
    }

    let path = resolve(&target);
    if seen_links.insert(target.clone()) {
        links.push(ResolvedLink {
            target: target.clone(),
            path: path.clone(),
        });
    }

    match path {
        Some(p) => format!(
            "<a class=\"wikilink\" data-path=\"{}\" data-target=\"{}\">{}</a>",
            escape_html(&p),
            escape_html(&target),
            escape_html(&label),
        ),
        None => format!(
            "<a class=\"wikilink missing\" data-target=\"{}\">{}</a>",
            escape_html(&target),
            escape_html(&label),
        ),
    }
}

/// Split a wikilink's inner text into `(resolve_target, display_label)`.
/// Handles `target|alias` and strips `#heading` / `^block` from the target.
fn clean_wikilink(inner: &str) -> (String, String) {
    let (link_part, alias) = match inner.split_once('|') {
        Some((l, a)) => (l, Some(a.trim())),
        None => (inner, None),
    };
    let target = link_part
        .split(['#', '^'])
        .next()
        .unwrap_or("")
        .trim()
        .replace('\\', "/");
    let label = alias
        .filter(|a| !a.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| link_part.trim().to_string());
    (target, label)
}

/// A tag must be non-empty and not purely numeric (so `#123` isn't a tag).
fn is_valid_tag(name: &str) -> bool {
    !name.is_empty() && name.chars().any(|c| !c.is_ascii_digit())
}

/// Merge frontmatter `tags`/`tag` (string or list) into `tags`.
fn collect_frontmatter_tags(value: &serde_json::Value, tags: &mut BTreeSet<String>) {
    match value {
        serde_json::Value::String(s) => {
            for part in s.split([',', ' ']) {
                let t = part.trim().trim_start_matches('#');
                if is_valid_tag(t) {
                    tags.insert(t.to_string());
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    let t = s.trim().trim_start_matches('#');
                    if is_valid_tag(t) {
                        tags.insert(t.to_string());
                    }
                }
            }
        }
        _ => {}
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Run generated HTML through a configured `ammonia` cleaner.
///
/// Beyond ammonia's safe defaults we permit:
/// - `input` (`type`/`checked`/`disabled` only) for GFM task-list checkboxes.
/// - `class` on code/pre/span (syntax highlighting, tag/mermaid hints).
/// - `class` + `data-path`/`data-target` on `a`, and `data-tag` on `span`, so
///   the frontend can wire wikilink/tag clicks. These carry no script capability.
fn sanitize(raw_html: &str) -> String {
    static CLEANER: LazyLock<Builder<'static>> = LazyLock::new(|| {
        let mut builder = Builder::default();
        builder.add_tags(["input"]);
        builder.add_tag_attributes("input", ["type", "checked", "disabled"]);
        builder.add_tag_attributes("code", ["class"]);
        builder.add_tag_attributes("pre", ["class"]);
        builder.add_tag_attributes("span", ["class", "data-tag"]);
        builder.add_tag_attributes("a", ["class", "data-path", "data-target"]);
        builder
    });
    CLEANER.clean(raw_html).to_string()
}

/// Return the body of `content` with any leading YAML frontmatter removed.
/// Used by the folder-compile feature.
pub fn body_without_frontmatter(content: &str) -> &str {
    split_frontmatter(content).1
}

/// Parse a leading `---` YAML frontmatter block. Returns
/// `(value, parse_error, body)`. On a malformed block, `value` is `None`,
/// `parse_error` is `Some`, and the whole original input is the body.
fn parse_frontmatter(content: &str) -> (Option<serde_json::Value>, Option<String>, &str) {
    let (raw, body) = split_frontmatter(content);
    match raw {
        Some(raw) if !raw.trim().is_empty() => {
            match serde_yaml::from_str::<serde_json::Value>(raw) {
                Ok(value) => (Some(value), None, body),
                Err(e) => (None, Some(e.to_string()), body),
            }
        }
        _ => (None, None, body),
    }
}

/// Split a leading `---` frontmatter fence from the body. See module docs.
fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let after_open = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"));
    let Some(after_open) = after_open else {
        return (None, content);
    };

    let mut offset = 0;
    for line in after_open.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            let yaml = &after_open[..offset];
            let body = &after_open[offset + line.len()..];
            return (Some(yaml), body);
        }
        offset += line.len();
    }
    (None, content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_resolve(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn renders_basic_gfm() {
        let out = render("# Title\n\n- [x] done\n- [ ] todo\n\n~~old~~ **bold**", no_resolve);
        assert!(out.html.contains("<h1>Title</h1>"));
        assert!(out.html.contains("<del>old</del>"));
        assert!(out.html.contains("type=\"checkbox\""));
    }

    #[test]
    fn parses_frontmatter_and_body() {
        let out = render("---\ntitle: Hello\ntags:\n  - a\n---\n# Body", no_resolve);
        let fm = out.frontmatter.expect("frontmatter present");
        assert_eq!(fm["title"], "Hello");
        assert!(out.html.contains("<h1>Body</h1>"));
        assert!(!out.html.contains("title:"));
    }

    #[test]
    fn malformed_frontmatter_reports_error_but_still_renders() {
        let out = render("---\ntitle: : :\n bad\n---\n# Still here", no_resolve);
        assert!(out.frontmatter.is_none());
        assert!(out.frontmatter_error.is_some());
        assert!(out.html.contains("Still here"));
    }

    #[test]
    fn sanitizes_dangerous_html() {
        let out = render("Hi <script>alert(1)</script> <img src=x onerror=alert(2)>", no_resolve);
        assert!(!out.html.contains("<script"));
        assert!(!out.html.contains("onerror"));
    }

    #[test]
    fn sanitizes_javascript_links() {
        let out = render("[click](javascript:alert(1))", no_resolve);
        assert!(!out.html.contains("javascript:"));
    }

    #[test]
    fn resolves_existing_and_missing_wikilinks() {
        let resolve = |t: &str| {
            if t.eq_ignore_ascii_case("Existing") {
                Some("notes/Existing.md".to_string())
            } else {
                None
            }
        };
        let out = render("See [[Existing]] and [[Ghost|the ghost]].", resolve);
        assert!(out
            .html
            .contains("<a class=\"wikilink\" data-path=\"notes/Existing.md\""));
        assert!(out.html.contains("class=\"wikilink missing\""));
        assert!(out.html.contains(">the ghost</a>"));
        assert_eq!(out.links.len(), 2);
    }

    #[test]
    fn renders_tags_but_not_headings_or_code() {
        let out = render("# Heading\n\nA #project/alpha tag.\n\n`#notatag`", no_resolve);
        assert!(out.html.contains("<h1>Heading</h1>")); // heading, not a tag
        assert!(out.html.contains("data-tag=\"project/alpha\""));
        assert!(out.tags.contains(&"project/alpha".to_string()));
        assert!(!out.html.contains("data-tag=\"notatag\"")); // inline code untouched
    }

    #[test]
    fn ignores_numeric_tags() {
        let out = render("Issue #123 is open", no_resolve);
        assert!(out.tags.is_empty());
        assert!(!out.html.contains("data-tag"));
    }

    #[test]
    fn keeps_markdown_around_wikilinks() {
        // Emphasis adjacent to a wikilink must still render.
        let out = render("**bold** and [[Note]] text", |_| Some("Note.md".into()));
        assert!(out.html.contains("<strong>bold</strong>"));
        assert!(out.html.contains("class=\"wikilink\""));
    }

    #[test]
    fn extract_collects_links_and_tags() {
        let ex = extract("---\ntitle: T\ntags: [x, y]\n---\n[[A]] and [[B|alias]] #z");
        assert_eq!(ex.title.as_deref(), Some("T"));
        assert!(ex.links.contains(&"A".to_string()));
        assert!(ex.links.contains(&"B".to_string()));
        assert!(ex.tags.contains(&"x".to_string()));
        assert!(ex.tags.contains(&"z".to_string()));
    }

    #[test]
    fn wikilinks_in_code_are_ignored() {
        let ex = extract("```\n[[NotALink]]\n```\n[[RealLink]]");
        assert_eq!(ex.links, vec!["RealLink".to_string()]);
    }

    #[test]
    fn inline_code_wikilink_ignored() {
        let ex = extract("`[[NotALink]]` but [[Real]]");
        assert_eq!(ex.links, vec!["Real".to_string()]);
    }

    #[test]
    fn toggles_task_by_index() {
        let md = "- [ ] a\n- [x] b\n- [ ] c";
        assert_eq!(toggle_task(md, 0).unwrap(), "- [x] a\n- [x] b\n- [ ] c");
        assert_eq!(toggle_task(md, 1).unwrap(), "- [ ] a\n- [ ] b\n- [ ] c");
        assert_eq!(toggle_task(md, 2).unwrap(), "- [ ] a\n- [x] b\n- [x] c");
        assert!(toggle_task(md, 3).is_none()); // out of range
    }

    #[test]
    fn task_index_skips_fenced_code() {
        // The `- [ ]` inside the fence isn't rendered as a checkbox, so index 1
        // must refer to "second", not the fenced line.
        let md = "- [ ] real\n\n```\n- [ ] fake\n```\n\n- [ ] second";
        let out = toggle_task(md, 1).unwrap();
        assert!(out.contains("- [x] second"));
        assert!(out.contains("- [ ] fake")); // untouched
    }

    #[test]
    fn toggle_preserves_frontmatter() {
        let md = "---\ntitle: T\n---\n- [ ] task";
        let out = toggle_task(md, 0).unwrap();
        assert!(out.starts_with("---\ntitle: T\n---\n"));
        assert!(out.contains("- [x] task"));
    }
}
