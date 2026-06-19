// Graph View: a hand-rolled force-directed layout on <canvas>. No graph library
// — the simulation is a standard spring-electrical model (Fruchterman-Reingold
// style): edges pull connected nodes together, all nodes repel each other, and
// a weak gravity keeps the layout centered. Cooling (alpha decay) settles it,
// and any interaction reheats it.
//
// Interactions: scroll to zoom, drag the background to pan, drag a node to move
// it, click a node to open that note. Esc or the close button dismisses.

import type { GraphData } from "../types";
import { iconSvg } from "./icons";

interface SimNode {
  id: string;
  label: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned by the user (during drag) — skip force integration. */
  fixed: boolean;
}

interface SimEdge {
  source: SimNode;
  target: SimNode;
}

export interface GraphCallbacks {
  onOpenNote: (path: string) => void;
}

export class GraphView {
  private overlay: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private nodes: SimNode[] = [];
  private edges: SimEdge[] = [];

  // Logical (CSS-pixel) canvas size. All simulation/drawing happens in this
  // space; the context is pre-scaled by devicePixelRatio for crisp rendering.
  private viewW = 0;
  private viewH = 0;

  // Camera (world → screen): screen = (world * scale) + offset.
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  private alpha = 1; // simulation "temperature"
  private rafId: number | null = null;

  // Interaction state.
  private hover: SimNode | null = null;
  private dragNode: SimNode | null = null;
  private panning = false;
  private pointerMoved = false;
  private lastPointer = { x: 0, y: 0 };

  constructor(mount: HTMLElement, private cb: GraphCallbacks) {
    this.overlay = document.createElement("div");
    this.overlay.className = "graph-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="graph-toolbar">
        <span class="graph-title">Graph View</span>
        <button class="graph-close" title="Close (Esc)">${iconSvg("close")}</button>
      </div>
    `;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "graph-canvas";
    this.overlay.appendChild(this.canvas);
    mount.appendChild(this.overlay);

    this.ctx = this.canvas.getContext("2d")!;

    this.overlay
      .querySelector<HTMLButtonElement>(".graph-close")!
      .addEventListener("click", () => this.close());

    this.bindInteractions();
  }

  /** Load data and show the overlay. */
  open(data: GraphData): void {
    // Show first, THEN measure — a hidden element reports a 0×0 rect.
    this.overlay.hidden = false;
    const { width, height } = this.sizeCanvas();

    // Seed positions on a circle so the layout unfolds predictably.
    const map = new Map<string, SimNode>();
    this.nodes = data.nodes.map((n, i) => {
      const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
      const radius = Math.min(width, height) * 0.3;
      const node: SimNode = {
        id: n.id,
        label: n.label,
        degree: n.degree,
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        fixed: false,
      };
      map.set(n.id, node);
      return node;
    });
    this.edges = data.edges
      .map((e) => ({ source: map.get(e.source), target: map.get(e.target) }))
      .filter((e): e is SimEdge => !!e.source && !!e.target);

    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.alpha = 1;
    this.startLoop();
  }

  close(): void {
    this.overlay.hidden = true;
    this.stopLoop();
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  // --- Simulation ---------------------------------------------------------

  private tick(): void {
    const cx = this.viewW / 2;
    const cy = this.viewH / 2;

    const repulsion = 9000; // node-node repulsive constant
    const springLen = 90; // ideal edge length
    const springK = 0.02; // edge stiffness
    const gravity = 0.015; // pull toward center
    const damping = 0.85;

    // Repulsion (O(n^2) — fine for the typical vault size).
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < this.nodes.length; j++) {
        const b = this.nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 0.01) {
          dx = (Math.random() - 0.5) * 0.1;
          dy = (Math.random() - 0.5) * 0.1;
          distSq = dx * dx + dy * dy;
        }
        const force = repulsion / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Spring attraction along edges.
    for (const e of this.edges) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist - springLen) * springK;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      e.source.vx += fx;
      e.source.vy += fy;
      e.target.vx -= fx;
      e.target.vy -= fy;
    }

    // Integrate with gravity + damping, scaled by cooling alpha.
    for (const n of this.nodes) {
      if (n.fixed) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx += (cx - n.x) * gravity;
      n.vy += (cy - n.y) * gravity;
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx * this.alpha;
      n.y += n.vy * this.alpha;
    }

    this.alpha *= 0.992; // cool down
  }

  private draw(): void {
    const { ctx } = this;
    // clearRect runs through the dpr-scaled transform, so use logical size.
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // Edges.
    ctx.strokeStyle = "rgba(150,150,150,0.25)";
    ctx.lineWidth = 1;
    for (const e of this.edges) {
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
    }

    // Nodes.
    for (const n of this.nodes) {
      const r = this.radius(n);
      const isHover = n === this.hover;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHover ? "#7cc0ff" : "#4fa3ff";
      ctx.fill();

      // Labels for hovered or well-connected nodes (avoids clutter).
      if (isHover || n.degree >= 2 || this.scale > 1.4) {
        ctx.fillStyle = isHover ? "#fff" : "rgba(212,212,212,0.85)";
        ctx.font = `${12 / this.scale + 2}px -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(n.label, n.x, n.y - r - 4);
      }
    }
    ctx.restore();
  }

  private loop = (): void => {
    this.tick();
    this.draw();
    // Keep animating while warm or while the user is interacting.
    if (this.alpha > 0.01 || this.dragNode) {
      this.rafId = requestAnimationFrame(this.loop);
    } else {
      this.rafId = null;
    }
  };

  private startLoop(): void {
    if (this.rafId === null) this.rafId = requestAnimationFrame(this.loop);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private reheat(): void {
    this.alpha = Math.max(this.alpha, 0.3);
    this.startLoop();
  }

  // --- Geometry / hit-testing --------------------------------------------

  private radius(n: SimNode): number {
    return 4 + Math.min(10, n.degree * 1.5);
  }

  private sizeCanvas(): { width: number; height: number } {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    // Fall back to the viewport if layout hasn't settled yet (rect can be 0
    // for a frame right after un-hiding).
    const width = rect.width || window.innerWidth;
    const height = rect.height || window.innerHeight - 44;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = width;
    this.viewH = height;
    return { width, height };
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale,
    };
  }

  private nodeAt(sx: number, sy: number): SimNode | null {
    const { x, y } = this.screenToWorld(sx, sy);
    // Reverse order so topmost (last-drawn) wins.
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const r = this.radius(n) + 3;
      if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r * r) return n;
    }
    return null;
  }

  // --- Interaction --------------------------------------------------------

  private bindInteractions(): void {
    const c = this.canvas;

    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      const { x: sx, y: sy } = this.localPoint(e);
      this.pointerMoved = false;
      this.lastPointer = { x: sx, y: sy };
      const node = this.nodeAt(sx, sy);
      if (node) {
        this.dragNode = node;
        node.fixed = true;
      } else {
        this.panning = true;
      }
    });

    c.addEventListener("pointermove", (e) => {
      const { x: sx, y: sy } = this.localPoint(e);
      const dx = sx - this.lastPointer.x;
      const dy = sy - this.lastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.pointerMoved = true;

      if (this.dragNode) {
        const w = this.screenToWorld(sx, sy);
        this.dragNode.x = w.x;
        this.dragNode.y = w.y;
        this.reheat();
      } else if (this.panning) {
        this.offsetX += dx;
        this.offsetY += dy;
        this.startLoop();
      } else {
        const prev = this.hover;
        this.hover = this.nodeAt(sx, sy);
        c.style.cursor = this.hover ? "pointer" : "default";
        if (prev !== this.hover) this.startLoop();
      }
      this.lastPointer = { x: sx, y: sy };
    });

    const endPointer = (e: PointerEvent) => {
      const { x: sx, y: sy } = this.localPoint(e);
      if (this.dragNode) {
        this.dragNode.fixed = false;
        // A press without movement = a click → open the note.
        if (!this.pointerMoved) {
          const id = this.dragNode.id;
          this.dragNode = null;
          this.close();
          this.cb.onOpenNote(id);
          return;
        }
      } else if (this.panning && !this.pointerMoved) {
        const node = this.nodeAt(sx, sy);
        if (node) {
          this.close();
          this.cb.onOpenNote(node.id);
          return;
        }
      }
      this.dragNode = null;
      this.panning = false;
    };
    c.addEventListener("pointerup", endPointer);
    c.addEventListener("pointercancel", () => {
      if (this.dragNode) this.dragNode.fixed = false;
      this.dragNode = null;
      this.panning = false;
    });

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const { x: sx, y: sy } = this.localPoint(e);
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newScale = Math.min(4, Math.max(0.2, this.scale * factor));
        // Zoom toward the cursor: keep the world point under the cursor fixed.
        const world = this.screenToWorld(sx, sy);
        this.scale = newScale;
        this.offsetX = sx - world.x * this.scale;
        this.offsetY = sy - world.y * this.scale;
        this.startLoop();
      },
      { passive: false },
    );

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) this.close();
    });

    window.addEventListener("resize", () => {
      if (this.isOpen) {
        this.sizeCanvas();
        this.startLoop();
      }
    });
  }

  private localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
}
