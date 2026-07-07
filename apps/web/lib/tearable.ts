// Verlet-integrated tearable cloth, textured with an image (à la pushmatrix/
// tearable). Framework-agnostic: the React hook drives step()/draw() from a
// single rAF loop and forwards pointer input.

type Point = {
  x: number;
  y: number;
  px: number; // previous position (verlet)
  py: number;
  u: number; // texture coord, image pixels
  v: number;
  pinned: boolean;
  active: boolean; // false once far offscreen (skipped => cleanup)
};

type Constraint = { a: number; b: number; len: number; torn: boolean };

// Tunable physics. The lab page (/lab) mutates this object live; whatever feels
// right there is copied into DEFAULT_PARAMS and shipped.
export type ClothParams = {
  gravity: number; // px/s^2, fall speed on collapse
  damping: number; // 0..1, lower = more jiggle
  iterations: number; // constraint passes, higher = stiffer
  tearFactor: number; // auto-tear when a link stretches past len * this
  cutStretch: number; // drag-cut in-radius links stretched past len * this
  pull: number; // grab pull strength toward cursor (0..1)
  momentum: number; // how much drag velocity is carried (0..1)
  radiusMul: number; // tear radius = grid spacing * this
  revealRatio: number; // detached fraction that auto-collapses (read by the hook)
  autoCollapseMs: number; // fall on its own after this long even if barely torn (0 = off)
};

export const DEFAULT_PARAMS: ClothParams = {
  gravity: 1800,
  damping: 0.98,
  iterations: 3,
  tearFactor: 2.9,
  cutStretch: 1.5,
  pull: 0.38,
  momentum: 0.6,
  radiusMul: 1.7,
  // Fraction of the sheet that must come loose from the top before it all drops
  // and reveals. ~0.35 = a moderate tear frees a third of the cloth and it falls.
  revealRatio: 0.35,
  // Safety net: if tearing is fiddly, the sheet drops on its own after this.
  autoCollapseMs: 5500,
};

export class Cloth {
  private img: HTMLImageElement;
  private cols = 0;
  private rows = 0;
  private spacing = 0;
  private pts: Point[] = [];
  private cons: Constraint[] = [];
  private tornCount = 0;
  private collapsing = false;
  private started = false; // false = pristine sheet, drawn as one seamless image
  private p: ClothParams;
  width: number;
  height: number;

  constructor(img: HTMLImageElement, width: number, height: number, params?: ClothParams) {
    this.img = img;
    this.width = width;
    this.height = height;
    this.p = params ?? DEFAULT_PARAMS; // held by reference so live edits apply
    this.build();
  }

  private build(): void {
    this.spacing = Math.max(34, Math.round(this.width / 30));
    this.cols = Math.max(6, Math.ceil(this.width / this.spacing));
    this.rows = Math.max(6, Math.ceil(this.height / this.spacing));
    const stepX = this.width / this.cols;
    const stepY = this.height / this.rows;
    const iw = this.img.naturalWidth || 1;
    const ih = this.img.naturalHeight || 1;

    this.pts = [];
    for (let j = 0; j <= this.rows; j++) {
      for (let i = 0; i <= this.cols; i++) {
        const x = i * stepX;
        const y = j * stepY;
        this.pts.push({
          x,
          y,
          px: x,
          py: y,
          u: (i / this.cols) * iw,
          v: (j / this.rows) * ih,
          pinned: j === 0, // hang from the top edge
          active: true,
        });
      }
    }

    this.cons = [];
    this.tornCount = 0;
    this.started = false;
    const idx = (i: number, j: number) => j * (this.cols + 1) + i;
    for (let j = 0; j <= this.rows; j++) {
      for (let i = 0; i <= this.cols; i++) {
        if (i < this.cols) this.addConstraint(idx(i, j), idx(i + 1, j), stepX);
        if (j < this.rows) this.addConstraint(idx(i, j), idx(i, j + 1), stepY);
      }
    }
  }

  private addConstraint(a: number, b: number, len: number): void {
    this.cons.push({ a, b, len, torn: false });
  }

  /**
   * Fraction of the sheet still hanging from the pinned top edge (flood-fill
   * over intact links). Drops toward 0 as tears disconnect pieces — direction-
   * agnostic, so any tear pattern that frees enough cloth triggers the collapse.
   */
  attachedFraction(): number {
    const n = this.pts.length;
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const c of this.cons) {
      if (c.torn) continue;
      adj[c.a].push(c.b);
      adj[c.b].push(c.a);
    }
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.pts[i].pinned && this.pts[i].active) {
        seen[i] = 1;
        stack.push(i);
      }
    }
    while (stack.length) {
      const p = stack.pop()!;
      for (const q of adj[p]) {
        if (!seen[q] && this.pts[q].active) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    let attached = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!this.pts[i].active) continue;
      total++;
      if (seen[i]) attached++;
    }
    return total ? attached / total : 1;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.collapsing = false;
    this.build();
  }

  step(dt: number): void {
    if (!this.started) return; // pristine sheet is static until first touched
    const g = this.p.gravity * dt * dt;
    const damp = this.p.damping;
    for (const p of this.pts) {
      if (!p.active) continue;
      if (p.pinned) continue;
      const vx = (p.x - p.px) * damp;
      const vy = (p.y - p.py) * damp;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + g;
      // Deactivate pieces that have fallen well past the bottom (cleanup).
      if (p.y > this.height + 240) p.active = false;
    }

    const iterations = Math.max(1, Math.round(this.p.iterations));
    for (let k = 0; k < iterations; k++) {
      for (const c of this.cons) {
        if (c.torn) continue;
        const a = this.pts[c.a];
        const b = this.pts[c.b];
        if (!a.active || !b.active) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        if (dist > c.len * this.p.tearFactor) {
          c.torn = true;
          this.tornCount++;
          continue;
        }
        const diff = (c.len - dist) / dist / 2;
        const ox = dx * diff;
        const oy = dy * diff;
        if (!a.pinned) {
          a.x -= ox;
          a.y -= oy;
        }
        if (!b.pinned) {
          b.x += ox;
          b.y += oy;
        }
      }
    }
  }

  /**
   * Grab the cloth near the cursor and pull it, then rip the links the drag has
   * actually over-stretched. A still/gentle touch only jiggles (nothing crosses
   * CUT_STRETCH); dragging through stretches links past it and tears along the
   * path — the "쫀득 then rip" feel.
   */
  pointerGrab(x: number, y: number, radius: number, push: { dx: number; dy: number }): void {
    this.started = true; // goes live on first touch
    const r2 = radius * radius;
    const pull = this.p.pull;
    const momentum = this.p.momentum;
    for (const p of this.pts) {
      if (p.pinned || !p.active) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      const f = 1 - Math.sqrt(d2) / radius; // 1 at cursor, 0 at the edge
      // Pull toward the cursor + carry drag momentum (strong enough to stretch).
      p.x += (x - p.x) * pull * f + push.dx * momentum * f;
      p.y += (y - p.y) * pull * f + push.dy * momentum * f;
    }
    // Tear the stretched links under the cursor.
    const cut = this.p.cutStretch;
    for (const c of this.cons) {
      if (c.torn) continue;
      const a = this.pts[c.a];
      const b = this.pts[c.b];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = mx - x;
      const dy = my - y;
      if (dx * dx + dy * dy >= r2) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) > c.len * cut) {
        c.torn = true;
        this.tornCount++;
      }
    }
  }

  /** Skip: slice the cloth down the middle and drop everything. */
  slice(): void {
    const midI = Math.round(this.cols / 2);
    const idx = (i: number, j: number) => j * (this.cols + 1) + i;
    const mid = new Set<number>();
    for (let j = 0; j <= this.rows; j++) mid.add(idx(midI, j));
    for (const c of this.cons) {
      if (!c.torn && (mid.has(c.a) || mid.has(c.b))) {
        c.torn = true;
        this.tornCount++;
      }
    }
    this.collapse();
  }

  /** Unpin the top edge — gravity collapses the whole sheet. */
  collapse(): void {
    if (this.collapsing) return;
    this.collapsing = true;
    this.started = true;
    for (const p of this.pts) p.pinned = false;
  }

  get isCollapsing(): boolean {
    return this.collapsing;
  }

  get tearRadius(): number {
    return this.spacing * this.p.radiusMul;
  }

  tornRatio(): number {
    return this.cons.length ? this.tornCount / this.cons.length : 0;
  }

  /** True once effectively nothing is left on screen. */
  allGone(): boolean {
    return this.pts.every((p) => !p.active || p.y > this.height + 200);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    // Pristine sheet: one seamless drawImage, no mesh (no triangle seams).
    if (!this.started) {
      ctx.drawImage(this.img, 0, 0, this.width, this.height);
      return;
    }
    const idx = (i: number, j: number) => j * (this.cols + 1) + i;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const a = this.pts[idx(i, j)];
        const b = this.pts[idx(i + 1, j)];
        const c = this.pts[idx(i, j + 1)];
        const d = this.pts[idx(i + 1, j + 1)];
        if (!a.active || !b.active || !c.active || !d.active) continue;
        // Skip a whole cell that has drifted entirely offscreen (cleanup).
        const minY = Math.min(a.y, b.y, c.y, d.y);
        if (minY > this.height + 40) continue;
        this.tri(ctx, a, b, c);
        this.tri(ctx, b, d, c);
      }
    }
  }

  // Draw one texture-mapped triangle via the uv->xy affine transform.
  private tri(ctx: CanvasRenderingContext2D, p0: Point, p1: Point, p2: Point): void {
    const { x: x0, y: y0, u: u0, v: v0 } = p0;
    const { x: x1, y: y1, u: u1, v: v1 } = p1;
    const { x: x2, y: y2, u: u2, v: v2 } = p2;
    const denom = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
    if (denom === 0) return;
    const a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / denom;
    const b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / denom;
    const c = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / denom;
    const d = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / denom;
    const e =
      (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / denom;
    const f =
      (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / denom;

    // Inflate the clip path outward from the centroid by ~1px so adjacent
    // triangles overlap — kills the hairline seams that show the grid on the
    // intact sheet. The transform stays on the original verts, so the overdraw
    // just samples neighbouring texels and lines up.
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const grow = (vx: number, vy: number): [number, number] => {
      const dx = vx - cx;
      const dy = vy - cy;
      const len = Math.hypot(dx, dy) || 1;
      const k = (len + 1.2) / len;
      return [cx + dx * k, cy + dy * k];
    };
    const [gx0, gy0] = grow(x0, y0);
    const [gx1, gy1] = grow(x1, y1);
    const [gx2, gy2] = grow(x2, y2);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(gx0, gy0);
    ctx.lineTo(gx1, gy1);
    ctx.lineTo(gx2, gy2);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(this.img, 0, 0);
    ctx.restore(); // restores both the clip and the base transform
  }
}
