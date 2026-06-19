//! Folder "compile": concatenate all notes under a folder into one document.
//!
//! Walks every `.md` under `dir` (recursive, tree order), strips each note's
//! YAML frontmatter, and prefixes it with an `# H1` of its filename. The result
//! is written by the caller (typically to a file *outside* the folder). The
//! `output` path is excluded so re-compiling never ingests its own result.
//!
//! Tauri-free and unit-tested.

use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::markdown;
use crate::vault::tree;

/// Build the compiled document for `dir` ("" = whole vault), excluding the
/// `output` path. Returns an error if the folder contains no notes.
pub fn compile_folder(root: &Path, dir: &str, output: &str) -> AppResult<String> {
    let files = tree::collect_files(root)?; // vault-relative, sorted (tree order)
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };

    let mut sections: Vec<String> = Vec::new();
    for rel in files {
        if rel == output {
            continue; // never include the compile target itself
        }
        if !prefix.is_empty() && !rel.starts_with(&prefix) {
            continue;
        }

        let abs = root.join(&rel);
        let content = std::fs::read_to_string(&abs).map_err(|e| AppError::io(&abs, e))?;
        let body = markdown::body_without_frontmatter(&content).trim();

        let mut section = format!("# {}\n", title_of(&rel));
        if !body.is_empty() {
            section.push('\n');
            section.push_str(body);
        }
        sections.push(section);
    }

    if sections.is_empty() {
        let where_ = if dir.is_empty() { "the vault" } else { dir };
        return Err(AppError::NotFound(format!("no notes to compile in {where_}")));
    }

    // Blank line between sections, trailing newline at EOF.
    Ok(format!("{}\n", sections.join("\n\n")))
}

/// Filename (without `.md`/`.markdown`) used as a section heading.
fn title_of(rel: &str) -> &str {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    for ext in [".md", ".markdown"] {
        if base.len() > ext.len() && base[base.len() - ext.len()..].eq_ignore_ascii_case(ext) {
            return &base[..base.len() - ext.len()];
        }
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, content: &str) {
        let abs = root.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, content).unwrap();
    }

    fn tmp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "crewrite-compile-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn compiles_recursively_stripping_frontmatter_with_titles() {
        let root = tmp();
        write(&root, "Book/01 Intro.md", "---\ntitle: x\n---\nHello intro.");
        write(&root, "Book/Part/02 Body.md", "Body text.");
        write(&root, "Outside.md", "Should be excluded.");

        let out = compile_folder(&root, "Book", "Book.md").unwrap();
        assert!(out.contains("# 01 Intro\n\nHello intro."));
        assert!(out.contains("# 02 Body\n\nBody text."));
        assert!(!out.contains("title: x")); // frontmatter stripped
        assert!(!out.contains("Should be excluded")); // outside the folder
        // Tree order: "01 Intro" before "02 Body".
        assert!(out.find("01 Intro").unwrap() < out.find("02 Body").unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn excludes_the_output_file() {
        let root = tmp();
        write(&root, "Book/a.md", "A");
        write(&root, "Book/Book.md", "stale previous compile");
        // Output lives inside the folder; it must not ingest itself.
        let out = compile_folder(&root, "Book", "Book/Book.md").unwrap();
        assert!(out.contains("# a\n\nA"));
        assert!(!out.contains("stale previous compile"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn errors_when_empty() {
        let root = tmp();
        std::fs::create_dir_all(root.join("Empty")).unwrap();
        assert!(compile_folder(&root, "Empty", "Empty.md").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
