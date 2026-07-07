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

const GRAVITY = 1400; // px/s^2
const DAMP = 0.99;
const ITER = 3; // constraint relaxation passes
const TEAR_FACTOR = 4.5; // tear when stretched past len * this

export class Cloth {
  private img: HTMLImageElement;
  private cols = 0;
  private rows = 0;
  private spacing = 0;
  private pts: Point[] = [];
  private cons: Constraint[] = [];
  private tornCount = 0;
  private collapsing = false;
  width: number;
  height: number;

  constructor(img: HTMLImageElement, width: number, height: number) {
    this.img = img;
    this.width = width;
    this.height = height;
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

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.collapsing = false;
    this.build();
  }

  step(dt: number): void {
    const g = GRAVITY * dt * dt;
    for (const p of this.pts) {
      if (!p.active) continue;
      if (p.pinned) continue;
      const vx = (p.x - p.px) * DAMP;
      const vy = (p.y - p.py) * DAMP;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + g;
      // Deactivate pieces that have fallen well past the bottom (cleanup).
      if (p.y > this.height + 240) p.active = false;
    }

    for (let k = 0; k < ITER; k++) {
      for (const c of this.cons) {
        if (c.torn) continue;
        const a = this.pts[c.a];
        const b = this.pts[c.b];
        if (!a.active || !b.active) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        if (dist > c.len * TEAR_FACTOR) {
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

  /** Tear constraints (and shove points) within a radius of the cursor. */
  pointerTear(x: number, y: number, radius: number, push: { dx: number; dy: number }): void {
    const r2 = radius * radius;
    for (const c of this.cons) {
      if (c.torn) continue;
      const a = this.pts[c.a];
      const mx = (a.x + this.pts[c.b].x) / 2;
      const my = (a.y + this.pts[c.b].y) / 2;
      const dx = mx - x;
      const dy = my - y;
      if (dx * dx + dy * dy < r2) {
        c.torn = true;
        this.tornCount++;
      }
    }
    // Nudge nearby points so the drag feels physical.
    for (const p of this.pts) {
      if (p.pinned || !p.active) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy < r2) {
        p.x += push.dx * 0.6;
        p.y += push.dy * 0.6;
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
    for (const p of this.pts) p.pinned = false;
  }

  get isCollapsing(): boolean {
    return this.collapsing;
  }

  get tearRadius(): number {
    return this.spacing * 1.4;
  }

  tornRatio(): number {
    return this.cons.length ? this.tornCount / this.cons.length : 0;
  }

  /** True once effectively nothing is left on screen. */
  allGone(): boolean {
    return this.pts.every((p) => !p.active || p.y > this.height + 200);
  }

  draw(ctx: CanvasRenderingContext2D): void {
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

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(this.img, 0, 0);
    ctx.restore(); // restores both the clip and the base transform
  }
}
