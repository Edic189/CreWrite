// Render a Mermaid diagram source to a PNG (base64, no data-URL prefix) for
// export. Mermaid is JS-only and runs in the webview, so we render it to SVG
// (as the preview does) and rasterize that SVG onto a <canvas>.
//
// `htmlLabels: false` is important: it makes Mermaid emit plain SVG <text>
// instead of <foreignObject> (HTML), which a canvas cannot rasterize. We also
// force a light theme so diagrams read well on white export pages.

let initialized = false;
let seq = 0;

/** Render `source` to a base64-encoded PNG (no `data:` prefix), or throw. */
export async function mermaidToPngBase64(source: string): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral", // light, prints well on white paper
      flowchart: { htmlLabels: false },
      // Some diagram types read the flag at the top level too.
      htmlLabels: false,
    } as Parameters<typeof mermaid.initialize>[0]);
    initialized = true;
  }
  const { svg } = await mermaid.render(`export-mmd-${seq++}`, source);
  return await svgToPngBase64(svg);
}

/** Draw an SVG string onto a 2x canvas and return its PNG as base64. */
function svgToPngBase64(svg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { width, height } = svgSize(svg);
    const scale = 2; // render at 2x for crisp embedding
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("no 2d canvas context"));
          return;
        }
        // Opaque white background (diagrams use dark text).
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1] ?? "";
        if (!base64) reject(new Error("empty PNG"));
        else resolve(base64);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.onerror = () => reject(new Error("failed to rasterize SVG"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

/** Intrinsic size of a Mermaid SVG — prefer the viewBox (width may be "100%"). */
function svgSize(svg: string): { width: number; height: number } {
  const el = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const vb = (el.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    return { width: vb[2], height: vb[3] };
  }
  const w = parseFloat(el.getAttribute("width") ?? "");
  const h = parseFloat(el.getAttribute("height") ?? "");
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h };
  }
  return { width: 800, height: 600 };
}
