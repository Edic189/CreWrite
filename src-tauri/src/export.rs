//! Built-in export to DOCX / PDF — pure Rust, compiled into the app (no
//! external tools like Pandoc, nothing for the user to install).
//!
//! Markdown is parsed into a small block/span IR ([`to_blocks`]) and rendered
//! to DOCX (`docx-rs`) or PDF (`genpdf`, with DejaVu fonts embedded via
//! `include_bytes!`). Coverage is the common Markdown set: headings, bold/
//! italic/strikethrough/inline-code, lists, blockquotes, code blocks, rules,
//! tables (rendered as real grids with a bold header row), and task-list
//! checkboxes (☐ / ☑). Mermaid diagrams embed as images in **PDF only**; in
//! DOCX they export as their source text. Gathering of documents is
//! unit-tested; the byte output is checked for a valid container header.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::Path;

use image::GenericImageView;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::markdown;
use crate::vault::tree;

/// A genpdf image that moves to the top of the next page when it doesn't fit in
/// the space left on the current one (instead of being clipped at the boundary).
/// `height_mm` must be ≤ one page's content height, so the deferred render always
/// fits on the fresh page.
struct FitImage {
    image: genpdf::elements::Image,
    height_mm: f64,
    done: bool,
}

impl genpdf::Element for FitImage {
    fn render(
        &mut self,
        context: &genpdf::Context,
        area: genpdf::render::Area<'_>,
        style: genpdf::style::Style,
    ) -> Result<genpdf::RenderResult, genpdf::error::Error> {
        if self.done {
            return Ok(genpdf::RenderResult { size: genpdf::Size::new(0.0, 0.0), has_more: false });
        }
        // Not enough room left on this page → consume the remainder so genpdf
        // advances to a new page, where the image will fit and render.
        if f64::from(area.size().height) + 0.5 < self.height_mm {
            return Ok(genpdf::RenderResult {
                size: genpdf::Size::new(0.0, area.size().height),
                has_more: true,
            });
        }
        let result = self.image.render(context, area, style)?;
        self.done = true;
        Ok(result)
    }
}

/// One document to export (also used by the popup for naming).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDoc {
    pub name: String,
    pub content: String,
}

// --- Markdown → intermediate representation --------------------------------

#[derive(Clone, Default)]
struct Span {
    text: String,
    bold: bool,
    italic: bool,
    code: bool,
    strike: bool,
}

/// A table cell holds inline spans; a row is a list of cells.
type Cell = Vec<Span>;
type Row = Vec<Cell>;

enum Block {
    Heading(u8, Vec<Span>),
    Para(Vec<Span>),
    Item { ordered: bool, number: u64, depth: usize, task: Option<bool>, spans: Vec<Span> },
    Quote(Vec<Span>),
    Code(String),
    Rule,
    Table { header: Row, rows: Vec<Row> },
    /// A rasterized image (PNG bytes) — used for Mermaid diagrams rendered by
    /// the webview and passed in via `images`.
    Image(Vec<u8>),
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// Parse Markdown into blocks. Inline styles are tracked with nesting counters;
/// list items flush at their `End(Item)` so both tight and loose lists work.
fn to_blocks(md: &str, images: &HashMap<String, Vec<u8>>) -> Vec<Block> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);

    let mut blocks: Vec<Block> = Vec::new();
    let mut cur: Vec<Span> = Vec::new();
    let (mut bold, mut italic, mut strike) = (0u32, 0u32, 0u32);
    let mut quote = false;
    let mut lists: Vec<(bool, u64)> = Vec::new(); // (ordered, next number) per level
    let mut code_block: Option<String> = None;
    let mut code_lang: Option<String> = None; // fenced-block info string (e.g. "mermaid")
    let mut item_task: Option<bool> = None; // task-list checkbox for the current item
    // Table assembly: cell text accumulates into `cur`, flushed per cell/row.
    let mut in_table = false;
    let mut t_header: Row = Vec::new();
    let mut t_rows: Vec<Row> = Vec::new();
    let mut t_row: Row = Vec::new();

    // Captures nothing (flags passed in) so the style counters stay mutable.
    let push = |cur: &mut Vec<Span>, text: &str, code: bool, b: u32, i: u32, s: u32| {
        if !text.is_empty() {
            cur.push(Span {
                text: text.to_string(),
                bold: b > 0,
                italic: i > 0,
                code,
                strike: s > 0,
            });
        }
    };

    for event in Parser::new_ext(md, opts) {
        match event {
            Event::Start(Tag::Emphasis) => italic += 1,
            Event::End(TagEnd::Emphasis) => italic = italic.saturating_sub(1),
            Event::Start(Tag::Strong) => bold += 1,
            Event::End(TagEnd::Strong) => bold = bold.saturating_sub(1),
            Event::Start(Tag::Strikethrough) => strike += 1,
            Event::End(TagEnd::Strikethrough) => strike = strike.saturating_sub(1),

            Event::Start(Tag::BlockQuote(_)) => quote = true,
            Event::End(TagEnd::BlockQuote(_)) => quote = false,

            Event::Start(Tag::List(start)) => lists.push((start.is_some(), start.unwrap_or(1))),
            Event::End(TagEnd::List(_)) => {
                lists.pop();
            }
            Event::Start(Tag::Item) => item_task = None,
            Event::TaskListMarker(checked) => item_task = Some(checked),
            Event::End(TagEnd::Item) => {
                if let Some(&(ordered, number)) = lists.last() {
                    let depth = lists.len().saturating_sub(1);
                    blocks.push(Block::Item {
                        ordered,
                        number,
                        depth,
                        task: item_task.take(),
                        spans: std::mem::take(&mut cur),
                    });
                    if ordered {
                        if let Some(top) = lists.last_mut() {
                            top.1 += 1;
                        }
                    }
                }
            }

            Event::End(TagEnd::Heading(level)) => {
                blocks.push(Block::Heading(heading_level(level), std::mem::take(&mut cur)));
            }
            Event::End(TagEnd::Paragraph) => {
                if in_table || !lists.is_empty() {
                    // Inside a table cell or list item — flushed elsewhere.
                } else if quote {
                    blocks.push(Block::Quote(std::mem::take(&mut cur)));
                } else {
                    blocks.push(Block::Para(std::mem::take(&mut cur)));
                }
            }

            Event::Start(Tag::CodeBlock(kind)) => {
                code_block = Some(String::new());
                code_lang = match kind {
                    CodeBlockKind::Fenced(lang) => Some(lang.to_string()),
                    CodeBlockKind::Indented => None,
                };
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(text) = code_block.take() {
                    // A ```mermaid block becomes an embedded image when the webview
                    // pre-rendered it (keyed by trimmed source); else its source code.
                    let is_mermaid = code_lang.as_deref() == Some("mermaid");
                    match is_mermaid.then(|| images.get(text.trim())).flatten() {
                        Some(bytes) => blocks.push(Block::Image(bytes.clone())),
                        None => blocks.push(Block::Code(text.trim_end().to_string())),
                    }
                }
                code_lang = None;
            }

            // Tables: assemble cells/rows into a real grid (rendered with borders).
            Event::Start(Tag::Table(_)) => {
                in_table = true;
                t_header.clear();
                t_rows.clear();
                t_row.clear();
            }
            Event::End(TagEnd::TableCell) => t_row.push(std::mem::take(&mut cur)),
            Event::End(TagEnd::TableHead) => t_header = std::mem::take(&mut t_row),
            Event::End(TagEnd::TableRow) => t_rows.push(std::mem::take(&mut t_row)),
            Event::End(TagEnd::Table) => {
                blocks.push(Block::Table {
                    header: std::mem::take(&mut t_header),
                    rows: std::mem::take(&mut t_rows),
                });
                in_table = false;
            }

            Event::Text(t) => match code_block.as_mut() {
                Some(cb) => cb.push_str(&t),
                None => push(&mut cur, &t, false, bold, italic, strike),
            },
            Event::Code(t) => push(&mut cur, &t, true, bold, italic, strike),
            Event::SoftBreak | Event::HardBreak => match code_block.as_mut() {
                Some(cb) => cb.push('\n'),
                None => push(&mut cur, " ", false, bold, italic, strike),
            },
            Event::Rule => blocks.push(Block::Rule),
            _ => {}
        }
    }
    if !cur.is_empty() {
        blocks.push(Block::Para(cur));
    }
    blocks
}

// --- DOCX renderer (docx-rs) -----------------------------------------------

fn render_docx(blocks: &[Block]) -> AppResult<Vec<u8>> {
    use docx_rs::*;

    fn run(span: &Span) -> Run {
        let mut r = Run::new().add_text(&span.text);
        if span.bold {
            r = r.bold();
        }
        if span.italic {
            r = r.italic();
        }
        if span.strike {
            r = r.strike();
        }
        if span.code {
            r = r.fonts(RunFonts::new().ascii("Courier New"));
        }
        r
    }

    let mut docx = Docx::new();
    for block in blocks {
        let mut p = Paragraph::new();
        match block {
            Block::Heading(level, spans) => {
                let size = match level {
                    1 => 36,
                    2 => 30,
                    3 => 26,
                    4 => 24,
                    _ => 22,
                }; // half-points
                for s in spans {
                    p = p.add_run(run(s).bold().size(size));
                }
            }
            Block::Para(spans) => {
                for s in spans {
                    p = p.add_run(run(s));
                }
            }
            Block::Item { ordered, number, depth, task, spans } => {
                let prefix = match task {
                    Some(true) => "☑  ".to_string(),
                    Some(false) => "☐  ".to_string(),
                    None if *ordered => format!("{number}. "),
                    None => "•  ".to_string(),
                };
                p = p
                    .indent(Some((*depth as i32 + 1) * 360), None, None, None)
                    .add_run(Run::new().add_text(prefix));
                for s in spans {
                    p = p.add_run(run(s));
                }
            }
            Block::Quote(spans) => {
                p = p.indent(Some(720), None, None, None);
                for s in spans {
                    p = p.add_run(run(s).italic());
                }
            }
            Block::Code(text) => {
                // One paragraph per line, monospace.
                for line in text.lines() {
                    docx = docx.add_paragraph(
                        Paragraph::new()
                            .add_run(Run::new().add_text(line).fonts(RunFonts::new().ascii("Courier New"))),
                    );
                }
                continue;
            }
            Block::Rule => {
                p = p.add_run(Run::new().add_text("―".repeat(24)));
            }
            Block::Table { header, rows } => {
                let cells_of = |cell: &Cell, bold: bool| -> TableCell {
                    let mut cp = Paragraph::new();
                    for s in cell {
                        cp = cp.add_run(if bold { run(s).bold() } else { run(s) });
                    }
                    TableCell::new().add_paragraph(cp)
                };
                let mut trs: Vec<TableRow> = Vec::new();
                if !header.is_empty() {
                    trs.push(TableRow::new(header.iter().map(|c| cells_of(c, true)).collect()));
                }
                for row in rows {
                    trs.push(TableRow::new(row.iter().map(|c| cells_of(c, false)).collect()));
                }
                if !trs.is_empty() {
                    docx = docx.add_table(Table::new(trs));
                }
                continue;
            }
            // Mermaid images are PDF-only — for DOCX, `convert` passes an empty
            // image map so mermaid blocks fall back to a code block (their source
            // text), and this arm is never reached. Skip to keep the match total.
            Block::Image(_) => continue,
        }
        docx = docx.add_paragraph(p);
    }

    let mut buf = Vec::new();
    docx.build()
        .pack(Cursor::new(&mut buf))
        .map_err(|e| AppError::Export(format!("DOCX build failed: {e}")))?;
    Ok(buf)
}

// --- PDF renderer (genpdf, fonts embedded) ---------------------------------

fn render_pdf(blocks: &[Block]) -> AppResult<Vec<u8>> {
    use genpdf::{elements, fonts, style, Element};

    let load = |bytes: &'static [u8]| -> AppResult<fonts::FontData> {
        fonts::FontData::new(bytes.to_vec(), None)
            .map_err(|e| AppError::Export(format!("font load failed: {e}")))
    };
    let family = fonts::FontFamily {
        regular: load(include_bytes!("../assets/fonts/DejaVuSans.ttf"))?,
        bold: load(include_bytes!("../assets/fonts/DejaVuSans-Bold.ttf"))?,
        italic: load(include_bytes!("../assets/fonts/DejaVuSans-Oblique.ttf"))?,
        bold_italic: load(include_bytes!("../assets/fonts/DejaVuSans-BoldOblique.ttf"))?,
    };

    let mut doc = genpdf::Document::new(family);
    doc.set_minimal_conformance();
    // Add leading between lines — without it, a heading that wraps to two lines
    // renders with the lines nearly touching, and body text reads cramped.
    doc.set_line_spacing(1.25);
    let mut deco = genpdf::SimplePageDecorator::new();
    deco.set_margins(18);
    doc.set_page_decorator(deco);

    let span_style = |s: &Span| -> style::Style {
        let mut st = style::Style::new();
        if s.bold {
            st = st.bold();
        }
        if s.italic {
            st = st.italic();
        }
        st
    };

    for block in blocks {
        match block {
            Block::Heading(level, spans) => {
                let size = match level {
                    1 => 20,
                    2 => 17,
                    3 => 15,
                    4 => 13,
                    _ => 12,
                };
                let mut p = elements::Paragraph::default();
                for s in spans {
                    p.push_styled(&s.text, span_style(s).bold().with_font_size(size));
                }
                // More space above bigger headings, and a clear gap below.
                let above = if *level <= 2 { 10 } else { 7 };
                doc.push(p.padded(genpdf::Margins::trbl(above, 0, 5, 0)));
            }
            Block::Para(spans) => {
                let mut p = elements::Paragraph::default();
                for s in spans {
                    p.push_styled(&s.text, span_style(s));
                }
                doc.push(p.padded(genpdf::Margins::trbl(0, 0, 4, 0)));
            }
            Block::Item { ordered, number, depth, task, spans } => {
                let prefix = match task {
                    Some(true) => "☑  ".to_string(),
                    Some(false) => "☐  ".to_string(),
                    None if *ordered => format!("{number}. "),
                    None => "•  ".to_string(),
                };
                let mut p = elements::Paragraph::default();
                p.push(format!("{}{}", "    ".repeat(*depth), prefix));
                for s in spans {
                    p.push_styled(&s.text, span_style(s));
                }
                doc.push(p);
            }
            Block::Quote(spans) => {
                let mut p = elements::Paragraph::default();
                p.push("“ ");
                for s in spans {
                    p.push_styled(&s.text, span_style(s).italic());
                }
                doc.push(p.padded(genpdf::Margins::trbl(0, 0, 4, 8)));
            }
            Block::Code(text) => {
                for line in text.lines() {
                    doc.push(elements::Paragraph::new(line.to_string()));
                }
                doc.push(elements::Break::new(0.5));
            }
            Block::Rule => {
                doc.push(elements::Paragraph::new("―".repeat(40)));
            }
            Block::Table { header, rows } => {
                let ncols = header
                    .len()
                    .max(rows.iter().map(|r| r.len()).max().unwrap_or(0));
                if ncols == 0 {
                    continue;
                }
                let mut table = elements::TableLayout::new(vec![1; ncols]);
                table.set_cell_decorator(elements::FrameCellDecorator::new(true, true, false));

                // Header (bold) first, then body rows; ragged rows pad to `ncols`.
                let mut ordered_rows: Vec<(&Row, bool)> = Vec::new();
                if !header.is_empty() {
                    ordered_rows.push((header, true));
                }
                for r in rows {
                    ordered_rows.push((r, false));
                }
                for (cells, is_header) in ordered_rows {
                    let mut tr = table.row();
                    for c in 0..ncols {
                        let mut cp = elements::Paragraph::default();
                        if let Some(cell) = cells.get(c) {
                            for s in cell {
                                let st = span_style(s);
                                let st = if is_header { st.bold() } else { st };
                                cp.push_styled(&s.text, st);
                            }
                        }
                        tr.push_element(cp.padded(genpdf::Margins::trbl(1, 2, 1, 2)));
                    }
                    tr.push()
                        .map_err(|e| AppError::Export(format!("PDF table row failed: {e}")))?;
                }
                doc.push(table);
            }
            Block::Image(bytes) => {
                let decoded = image::load_from_memory(bytes)
                    .map_err(|e| AppError::Export(format!("image decode failed: {e}")))?;
                // genpdf/printpdf rejects images with an alpha channel. The PNG was
                // rendered onto an opaque white canvas, so flattening to RGB is safe.
                let rgb = image::DynamicImage::ImageRgb8(decoded.to_rgb8());
                let w_px = rgb.width() as f64;
                let h_px = rgb.height() as f64;
                let img = elements::Image::from_dynamic_image(rgb)
                    .map_err(|e| AppError::Export(format!("PDF image failed: {e}")))?;
                // Fit within the page content box (≈170mm wide, ≈250mm tall) so a
                // diagram is never taller than a page. PNG is 2x → /2 at 96dpi.
                let aspect = h_px / w_px;
                let mut w_mm = (w_px / 2.0 / 96.0 * 25.4).min(170.0);
                let mut h_mm = w_mm * aspect;
                if h_mm > 250.0 {
                    h_mm = 250.0;
                    w_mm = h_mm / aspect;
                }
                let dpi = w_px * 25.4 / w_mm;
                let image = img.with_alignment(genpdf::Alignment::Center).with_dpi(dpi);
                // Render via FitImage so it jumps to the next page if it won't fit.
                doc.push(FitImage { image, height_mm: h_mm, done: false });
            }
        }
    }

    let mut buf = Vec::new();
    doc.render(&mut buf)
        .map_err(|e| AppError::Export(format!("PDF render failed: {e}")))?;
    Ok(buf)
}

/// Convert Markdown `content` to the bytes of a `format` ("docx" | "pdf") file.
/// `images` maps a ```mermaid block's trimmed source to its rendered PNG bytes
/// (produced by the webview); matched blocks are embedded as images.
pub fn convert(content: &str, format: &str, images: &HashMap<String, Vec<u8>>) -> AppResult<Vec<u8>> {
    match format {
        "pdf" => render_pdf(&to_blocks(content, images)),
        // Word (.docx) doesn't embed Mermaid (docx-rs image embedding is
        // unreliable); an empty image map makes mermaid blocks export as their
        // source text instead.
        _ => render_docx(&to_blocks(content, &HashMap::new())),
    }
}

/// The trimmed source of every unique ```mermaid block across `docs`, in order.
/// The frontend renders each to a PNG keyed by this exact string so [`convert`]
/// can match and embed it.
pub fn mermaid_sources(docs: &[ExportDoc]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for doc in docs {
        for src in extract_mermaid(&doc.content) {
            if !src.is_empty() && seen.insert(src.clone()) {
                out.push(src);
            }
        }
    }
    out
}

/// Collect the trimmed source of each ```mermaid fenced block in `content`.
fn extract_mermaid(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf: Option<String> = None;
    for event in Parser::new_ext(content, Options::empty()) {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(lang))) if lang.as_ref() == "mermaid" => {
                buf = Some(String::new());
            }
            Event::Text(t) => {
                if let Some(b) = buf.as_mut() {
                    b.push_str(&t);
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(b) = buf.take() {
                    out.push(b.trim().to_string());
                }
            }
            _ => {}
        }
    }
    out
}

// --- Gathering documents (scope/combine/strip) -----------------------------

fn base_name(rel: &str) -> &str {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    for ext in [".md", ".markdown"] {
        if base.len() > ext.len() && base[base.len() - ext.len()..].eq_ignore_ascii_case(ext) {
            return &base[..base.len() - ext.len()];
        }
    }
    base
}

/// Collect documents to export (see the command for parameter meaning).
pub fn gather(
    root: &Path,
    scope: &str,
    path: &str,
    combine: bool,
    strip_frontmatter: bool,
) -> AppResult<Vec<ExportDoc>> {
    let rels: Vec<String> = match scope {
        "note" => vec![path.to_string()],
        "folder" => {
            let prefix = format!("{path}/");
            tree::collect_files(root)?
                .into_iter()
                .filter(|p| path.is_empty() || p.starts_with(&prefix))
                .collect()
        }
        _ => tree::collect_files(root)?,
    };
    if rels.is_empty() {
        return Err(AppError::NotFound("nothing to export".into()));
    }

    let read = |rel: &str| -> String {
        let raw = std::fs::read_to_string(root.join(rel)).unwrap_or_default();
        if strip_frontmatter {
            markdown::body_without_frontmatter(&raw).trim().to_string()
        } else {
            raw
        }
    };

    if !combine {
        return Ok(rels
            .iter()
            .map(|rel| ExportDoc {
                name: base_name(rel).to_string(),
                content: read(rel),
            })
            .collect());
    }

    let multi = rels.len() > 1;
    let sections: Vec<String> = rels
        .iter()
        .map(|rel| {
            let body = read(rel);
            if multi {
                format!("# {}\n\n{}", base_name(rel), body)
            } else {
                body
            }
        })
        .collect();
    let name = match scope {
        "note" => base_name(path).to_string(),
        "folder" if !path.is_empty() => base_name(path).to_string(),
        _ => "vault".to_string(),
    };
    Ok(vec![ExportDoc {
        name,
        content: format!("{}\n", sections.join("\n\n")),
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_images() -> HashMap<String, Vec<u8>> {
        HashMap::new()
    }

    #[test]
    fn converts_to_valid_containers() {
        let md = "# Title\n\nHello **bold** and *italic* and `code`.\n\n- a\n- b\n\n> quote\n\n```\nlet x = 1;\n```";
        let docx = convert(md, "docx", &no_images()).unwrap();
        assert_eq!(&docx[..2], b"PK"); // .docx is a zip
        let pdf = convert(md, "pdf", &no_images()).unwrap();
        assert_eq!(&pdf[..5], b"%PDF-"); // PDF header
    }

    #[test]
    fn pdf_embeds_rgba_image_without_alpha_error() {
        // An RGBA PNG (with an alpha channel) — genpdf rejects alpha, so the PDF
        // renderer must flatten it to RGB. DOCX accepts alpha as-is.
        let buf = image::ImageBuffer::from_fn(40, 30, |_, _| image::Rgba([10u8, 20, 30, 128]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(buf)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageOutputFormat::Png)
            .unwrap();
        let mut images = HashMap::new();
        images.insert("graph TD; A-->B;".to_string(), png);

        let md = "```mermaid\ngraph TD; A-->B;\n```";
        let pdf = convert(md, "pdf", &images).expect("RGBA image must not break PDF export");
        assert_eq!(&pdf[..5], b"%PDF-");
        assert_eq!(&convert(md, "docx", &images).unwrap()[..2], b"PK");
    }

    #[test]
    fn mermaid_block_source_extracted() {
        let md = "intro\n\n```mermaid\ngraph TD; A-->B;\n```\n\n```rust\nlet x = 1;\n```";
        let docs = [ExportDoc { name: "n".into(), content: md.into() }];
        assert_eq!(mermaid_sources(&docs), vec!["graph TD; A-->B;".to_string()]);
    }

    #[test]
    fn parses_tables_and_task_checkboxes() {
        let md = "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n- [ ] todo\n- [x] done\n- plain";
        let blocks = to_blocks(md, &no_images());

        // Table: 2 header columns, 2 body rows.
        let dims = blocks.iter().find_map(|b| match b {
            Block::Table { header, rows } => Some((header.len(), rows.len())),
            _ => None,
        });
        assert_eq!(dims, Some((2, 2)));

        // Task markers captured (None for the plain bullet).
        let tasks: Vec<Option<bool>> = blocks
            .iter()
            .filter_map(|b| match b {
                Block::Item { task, .. } => Some(*task),
                _ => None,
            })
            .collect();
        assert_eq!(tasks, vec![Some(false), Some(true), None]);

        // Both formats still produce valid containers with the new blocks.
        assert_eq!(&convert(md, "docx", &no_images()).unwrap()[..2], b"PK");
        assert_eq!(&convert(md, "pdf", &no_images()).unwrap()[..5], b"%PDF-");
    }

    fn tmp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "crewrite-export-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn write(root: &Path, rel: &str, content: &str) {
        let abs = root.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, content).unwrap();
    }

    #[test]
    fn gather_folder_combined_adds_titles() {
        let root = tmp();
        write(&root, "Book/01.md", "One");
        write(&root, "Book/02.md", "Two");
        write(&root, "Outside.md", "Nope");
        let docs = gather(&root, "folder", "Book", true, false).unwrap();
        assert_eq!(docs.len(), 1);
        assert!(docs[0].content.contains("# 01\n\nOne"));
        assert!(docs[0].content.contains("# 02\n\nTwo"));
        assert!(!docs[0].content.contains("Nope"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gather_vault_separate() {
        let root = tmp();
        write(&root, "A.md", "aaa");
        write(&root, "sub/B.md", "bbb");
        let docs = gather(&root, "vault", "", false, false).unwrap();
        assert_eq!(docs.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
