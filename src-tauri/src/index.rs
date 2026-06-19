//! Vault-wide link/tag index (Phase 3).
//!
//! Built by scanning every `.md` file once and extracting its wikilink targets
//! and tags ([`crate::markdown::extract`]). From that we derive:
//!   - a **resolution map** (Obsidian-style: a target resolves by relative path
//!     or by basename; on basename collisions the shortest path wins),
//!   - **backlinks** (who links to a note),
//!   - **graph** data (nodes + de-duplicated edges),
//!   - a **tag** census.
//!
//! The index is cached in [`crate::state`] and rebuilt on vault open, on
//! structural changes, and on (debounced) edits. Tauri-free and unit-tested.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use serde::Serialize;

use crate::error::AppResult;
use crate::markdown;
use crate::vault::tree;

/// One indexed note's extracted metadata.
#[derive(Debug, Clone)]
struct NoteEntry {
    /// Vault-relative, forward-slash path (e.g. "notes/Idea.md").
    path: String,
    /// Display title (frontmatter `title`, else basename without extension).
    title: String,
    /// Raw wikilink targets (alias/heading already stripped).
    raw_links: Vec<String>,
    /// Tags (without the leading `#`).
    tags: Vec<String>,
}

/// Cached, queryable vault index.
#[derive(Debug, Default)]
pub struct VaultIndex {
    notes: Vec<NoteEntry>,
    /// Lowercased lookup key → note path. Keys are both the full path-without-
    /// extension and the bare basename-without-extension.
    resolve: HashMap<String, String>,
}

/// A node in the relationship graph.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub tags: Vec<String>,
    /// Number of connected edges (used to size nodes in the UI).
    pub degree: u32,
}

/// A directed edge (source links to target).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

/// The full graph payload for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// A note referenced by path + title (used for backlinks and tag results).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef {
    pub path: String,
    pub title: String,
}

/// A tag with how many notes carry it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

/// Build the index by scanning the vault at `root`.
pub fn build(root: &Path) -> AppResult<VaultIndex> {
    let files = tree::collect_files(root)?;
    let mut notes = Vec::with_capacity(files.len());

    for path in files {
        let abs = root.join(&path);
        // An unreadable file shouldn't fail the whole index — treat as empty.
        let content = std::fs::read_to_string(&abs).unwrap_or_default();
        let extracted = markdown::extract(&content);
        let title = extracted
            .title
            .unwrap_or_else(|| basename_no_ext(&path).to_string());
        notes.push(NoteEntry {
            path,
            title,
            raw_links: extracted.links,
            tags: extracted.tags,
        });
    }

    let resolve = build_resolve(&notes);
    Ok(VaultIndex { notes, resolve })
}

impl VaultIndex {
    /// Resolve a raw wikilink target to a note path, if one exists.
    pub fn resolve(&self, target: &str) -> Option<String> {
        let key = strip_md(&target.replace('\\', "/")).to_lowercase();
        self.resolve.get(&key).cloned()
    }

    /// Build the relationship graph (nodes for every note, edges for resolved
    /// links). Edges are de-duplicated and self-links dropped.
    pub fn graph(&self) -> GraphData {
        let mut edge_set: BTreeSet<(String, String)> = BTreeSet::new();
        for note in &self.notes {
            for raw in &note.raw_links {
                if let Some(target) = self.resolve(raw) {
                    if target != note.path {
                        edge_set.insert((note.path.clone(), target));
                    }
                }
            }
        }

        let mut degree: HashMap<&str, u32> = HashMap::new();
        for (source, target) in &edge_set {
            *degree.entry(source.as_str()).or_insert(0) += 1;
            *degree.entry(target.as_str()).or_insert(0) += 1;
        }

        let nodes = self
            .notes
            .iter()
            .map(|n| GraphNode {
                id: n.path.clone(),
                label: n.title.clone(),
                tags: n.tags.clone(),
                degree: degree.get(n.path.as_str()).copied().unwrap_or(0),
            })
            .collect();

        let edges = edge_set
            .into_iter()
            .map(|(source, target)| GraphEdge { source, target })
            .collect();

        GraphData { nodes, edges }
    }

    /// Notes that link to `path`, sorted by title.
    pub fn backlinks(&self, path: &str) -> Vec<NoteRef> {
        let mut refs: Vec<NoteRef> = self
            .notes
            .iter()
            .filter(|n| n.path != path)
            .filter(|n| {
                n.raw_links
                    .iter()
                    .any(|raw| self.resolve(raw).as_deref() == Some(path))
            })
            .map(|n| NoteRef {
                path: n.path.clone(),
                title: n.title.clone(),
            })
            .collect();
        refs.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        refs
    }

    /// Tag census, sorted by descending count then tag name.
    pub fn tags(&self) -> Vec<TagCount> {
        let mut counts: BTreeMap<String, u32> = BTreeMap::new();
        for note in &self.notes {
            for tag in &note.tags {
                *counts.entry(tag.clone()).or_insert(0) += 1;
            }
        }
        let mut out: Vec<TagCount> = counts
            .into_iter()
            .map(|(tag, count)| TagCount { tag, count })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
        out
    }

    /// Notes carrying `tag` (case-insensitive), sorted by title.
    pub fn notes_with_tag(&self, tag: &str) -> Vec<NoteRef> {
        let needle = tag.trim_start_matches('#').to_lowercase();
        let mut refs: Vec<NoteRef> = self
            .notes
            .iter()
            .filter(|n| n.tags.iter().any(|t| t.to_lowercase() == needle))
            .map(|n| NoteRef {
                path: n.path.clone(),
                title: n.title.clone(),
            })
            .collect();
        refs.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        refs
    }
}

/// Build the basename/path → note resolution map.
fn build_resolve(notes: &[NoteEntry]) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    for note in notes {
        // Full relative path without extension (most specific).
        consider(&mut map, strip_md(&note.path), &note.path);
        // Bare basename without extension (Obsidian's default link form).
        consider(&mut map, basename_no_ext(&note.path), &note.path);
    }
    map
}

/// Insert `key → path`, preferring the shorter (fewer-segment) path on conflict.
fn consider(map: &mut HashMap<String, String>, key: &str, path: &str) {
    let key = key.to_lowercase();
    match map.get(&key) {
        Some(existing) if segment_count(existing) <= segment_count(path) => {}
        _ => {
            map.insert(key, path.to_string());
        }
    }
}

/// Strip a trailing `.md`/`.markdown` extension (case-insensitive).
fn strip_md(path: &str) -> &str {
    for ext in [".md", ".markdown"] {
        if path.len() >= ext.len() && path[path.len() - ext.len()..].eq_ignore_ascii_case(ext) {
            return &path[..path.len() - ext.len()];
        }
    }
    path
}

/// Final path segment with extension removed.
fn basename_no_ext(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    strip_md(base)
}

fn segment_count(path: &str) -> usize {
    path.matches('/').count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(path: &str, links: &[&str], tags: &[&str]) -> NoteEntry {
        NoteEntry {
            path: path.to_string(),
            title: basename_no_ext(path).to_string(),
            raw_links: links.iter().map(|s| s.to_string()).collect(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn index(notes: Vec<NoteEntry>) -> VaultIndex {
        let resolve = build_resolve(&notes);
        VaultIndex { notes, resolve }
    }

    #[test]
    fn resolves_by_basename_and_path() {
        let idx = index(vec![note("notes/Alpha.md", &[], &[]), note("Beta.md", &[], &[])]);
        assert_eq!(idx.resolve("Alpha").as_deref(), Some("notes/Alpha.md"));
        assert_eq!(idx.resolve("notes/Alpha").as_deref(), Some("notes/Alpha.md"));
        assert_eq!(idx.resolve("alpha").as_deref(), Some("notes/Alpha.md")); // case-insensitive
        assert_eq!(idx.resolve("Missing"), None);
    }

    #[test]
    fn basename_collision_prefers_shorter_path() {
        let idx = index(vec![
            note("deep/folder/Note.md", &[], &[]),
            note("Note.md", &[], &[]),
        ]);
        assert_eq!(idx.resolve("Note").as_deref(), Some("Note.md"));
    }

    #[test]
    fn backlinks_and_graph() {
        let idx = index(vec![
            note("A.md", &["B"], &[]),
            note("B.md", &["A", "B"], &[]), // self-link should be dropped
            note("C.md", &["B"], &[]),
        ]);

        let back_b = idx.backlinks("B.md");
        let names: Vec<&str> = back_b.iter().map(|r| r.path.as_str()).collect();
        assert!(names.contains(&"A.md") && names.contains(&"C.md"));
        assert_eq!(back_b.len(), 2);

        let graph = idx.graph();
        assert_eq!(graph.nodes.len(), 3);
        // A->B, C->B (B->B dropped, B->A counts).
        assert!(graph.edges.iter().any(|e| e.source == "A.md" && e.target == "B.md"));
        assert!(!graph.edges.iter().any(|e| e.source == "B.md" && e.target == "B.md"));
    }

    #[test]
    fn tag_census_and_lookup() {
        let idx = index(vec![
            note("A.md", &[], &["x", "y"]),
            note("B.md", &[], &["x"]),
        ]);
        let tags = idx.tags();
        assert_eq!(tags[0].tag, "x"); // highest count first
        assert_eq!(tags[0].count, 2);
        let with_x = idx.notes_with_tag("x");
        assert_eq!(with_x.len(), 2);
        assert_eq!(idx.notes_with_tag("#X").len(), 2); // hash + case tolerant
    }
}
