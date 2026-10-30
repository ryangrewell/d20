/**
 * PixiJS tabletop renderer. Owns only drawing; all state comes from the store
 * and all coordinates are native map pixels converted through the shared
 * transform module. Layer order follows spec 5.4.
 */
// Patches Pixi to avoid eval-based shader generation so a strict CSP (no 'unsafe-eval') works.
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { mapToScreen, type Camera, type Point } from '@shared/geometry/transform';
import { gridColorNumber, gridSpacingPixels, shouldDrawGrid } from '@shared/geometry/grid';
import { hexGridPolygons, squareGridSegments } from '@shared/geometry/gridLines';
import type { FogOp, FogShape, FogState } from '@shared/fog';
import type { MapDefinition } from '@shared/model';
import type { Ping, RemoteCursor, TableObject } from '../store';

const FOG_MAX_TEXTURE = 2048;
const TYPE_RING: Record<string, number> = { PC: 0xc9a24a, NPC: 0x3e8ed0, CREATURE: 0xe5484d, LOOT: 0x46a758, PROP: 0x8e8aa0, PIN: 0xa86cc1 };

export type Overlay = {
  ruler?: { a: Point; b: Point; label: string } | null;
  fogRect?: { a: Point; b: Point; mode: 'reveal' | 'conceal' } | null;
  fogBrush?: { points: Point[]; radius: number; mode: 'reveal' | 'conceal' } | null;
  dragGhost?: { id: string; x: number; y: number } | null;
};

const hex = (c: string | undefined, fallback: number) => (c && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : fallback);

export class TabletopRenderer {
  readonly app = new Application();
  private world = new Container();
  private background = new Sprite();
  private gridG = new Graphics();
  private tokens = new Container();
  private fogSprite = new Sprite();
  private overlayG = new Graphics();
  private screenLayer = new Container();
  private overlayText = new Text({ text: '', style: { fontFamily: 'Inter', fontSize: 13, fill: 0xffffff, fontWeight: '600', stroke: { color: 0x000000, width: 4 } } });
  private cursorLayer = new Container();
  private pingG = new Graphics();

  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private map: MapDefinition | null = null;
  private fogCanvas = document.createElement('canvas');
  private fogCtx = this.fogCanvas.getContext('2d')!;
  private fogScale = 1;
  private fogTexture: Texture | null = null;
  private tokenViews = new Map<string, { root: Container; disc: Graphics; label: Text; key: string }>();
  private cursorViews = new Map<string, Container>();
  private ready = false;
  private destroyed = false;
  private isGM = false;
  private lastObjects: TableObject[] = [];
  private lastCtx = { selectedId: null as string | null, mySub: '' };

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, background: 0x0b0a0f, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2) });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    host.appendChild(this.app.canvas);
    this.app.canvas.setAttribute('aria-hidden', 'true');
    this.app.canvas.style.display = 'block';
    this.world.addChild(this.background, this.gridG, this.tokens, this.fogSprite, this.overlayG);
    this.screenLayer.addChild(this.pingG, this.cursorLayer, this.overlayText);
    this.app.stage.addChild(this.world, this.screenLayer);
    this.tokens.sortableChildren = true;
    this.app.ticker.add(() => this.animatePings());
    this.ready = true;
  }

  get size() {
    return { w: this.app.screen?.width ?? 0, h: this.app.screen?.height ?? 0 };
  }

  destroy() {
    this.destroyed = true;
    if (this.ready) this.app.destroy(true, { children: true, texture: true });
  }

  // ------------------------------------------------------------------ map

  async setMap(map: MapDefinition, imageUrl: string | null): Promise<void> {
    this.map = map;
    this.background.texture = Texture.EMPTY;
    if (imageUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = imageUrl;
      await img.decode();
      if (this.destroyed || this.map !== map) return;
      this.background.texture = Texture.from(img);
    }
    this.background.width = map.widthPx;
    this.background.height = map.heightPx;
    this.resetFogCanvas();
    this.redrawGrid();
  }

  // --------------------------------------------------------------- camera

  setCamera(cam: Camera) {
    this.camera = cam;
    this.world.scale.set(cam.zoom);
    this.world.position.set(-cam.x * cam.zoom, -cam.y * cam.zoom);
    this.redrawGrid();
    this.rescaleLabels();
  }

  getCamera() {
    return this.camera;
  }

  private redrawGrid() {
    const g = this.gridG;
    g.clear();
    const map = this.map;
    if (!map?.calibration || map.grid.type === 'none' || !map.grid.showEnabled) return;
    const spacing = gridSpacingPixels(map.grid, map.calibration.pixelsPerMeter);
    if (!shouldDrawGrid(spacing, this.camera.zoom)) return;
    const { w, h } = this.size;
    const view = { x: Math.max(0, this.camera.x), y: Math.max(0, this.camera.y), w: Math.min(map.widthPx, w / this.camera.zoom), h: Math.min(map.heightPx, h / this.camera.zoom) };
    const width = 1 / this.camera.zoom;
    if (map.grid.type === 'square') {
      for (const [a, b] of squareGridSegments(map.grid, spacing, view)) g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    } else {
      for (const poly of hexGridPolygons(map.grid, spacing, view)) g.poly(poly.flatMap((p) => [p.x, p.y]), true);
    }
    g.stroke({ width, color: gridColorNumber(map.grid), alpha: map.grid.opacity });
  }

  // ------------------------------------------------------------------ fog

  private resetFogCanvas() {
    if (!this.map) return;
    const longest = Math.max(this.map.widthPx, this.map.heightPx);
    this.fogScale = Math.min(1, FOG_MAX_TEXTURE / longest);
    this.fogCanvas.width = Math.max(1, Math.round(this.map.widthPx * this.fogScale));
    this.fogCanvas.height = Math.max(1, Math.round(this.map.heightPx * this.fogScale));
    this.fogTexture?.destroy(true);
    this.fogTexture = null;
  }

  setFog(fog: FogState, isGM: boolean) {
    this.isGM = isGM;
    const ctx = this.fogCtx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    if (fog.initial === 'covered') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    }
    for (const op of fog.ops) this.drawFogOp(op);
    this.commitFog();
  }

  appendFogOp(op: FogOp) {
    this.drawFogOp(op);
    this.commitFog();
  }

  private drawFogOp(op: FogOp) {
    const ctx = this.fogCtx;
    ctx.globalCompositeOperation = op.mode === 'reveal' ? 'destination-out' : 'source-over';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    traceShape(ctx, op.shape, this.fogScale);
  }

  private commitFog() {
    if (!this.fogTexture) {
      this.fogTexture = Texture.from(this.fogCanvas);
      this.fogSprite.texture = this.fogTexture;
    } else {
      this.fogTexture.source.update();
    }
    if (this.map) {
      this.fogSprite.width = this.map.widthPx;
      this.fogSprite.height = this.map.heightPx;
    }
    // GMs see through fog with a tinted overlay; players see it opaque.
    this.fogSprite.alpha = this.isGM ? 0.45 : 1;
    this.fogSprite.tint = this.isGM ? 0x1b1f3a : 0x000000;
  }

  // --------------------------------------------------------------- tokens

  tokenRadius(o: TableObject): number {
    const map = this.map;
    if (!map) return 20;
    const ppm = map.calibration?.pixelsPerMeter;
    if (ppm) {
      const meters = o.sizeMeters ?? (map.grid.type !== 'none' ? map.grid.intervalMeters : 1.524);
      return Math.max(4, (meters * ppm) / 2);
    }
    return Math.max(10, Math.max(map.widthPx, map.heightPx) / 60);
  }

  setObjects(objects: TableObject[], ctx: { selectedId: string | null; mySub: string }) {
    this.lastObjects = objects;
    this.lastCtx = ctx;
    const keep = new Set<string>();
    for (const o of objects) {
      keep.add(o.id);
      const r = this.tokenRadius(o);
      const hidden = o.visibility !== 'VISIBLE_TO_ALL';
      const hp = 'gmStats' in o ? o.gmStats?.hp : undefined;
      const key = [r, o.appearance.tint, o.appearance.label, o.objectType, o.visibility, ctx.selectedId === o.id, o.assignedControllerSub === ctx.mySub, o.conditions?.join(','), hp ? `${hp.current}/${hp.max}` : ''].join('|');
      let view = this.tokenViews.get(o.id);
      if (!view) {
        const root = new Container();
        const disc = new Graphics();
        const label = new Text({ text: '', style: { fontFamily: 'Inter', fontSize: 14, fill: 0xffffff, fontWeight: '600', stroke: { color: 0x000000, width: 4 }, align: 'center' } });
        label.anchor.set(0.5, 0);
        root.addChild(disc, label);
        this.tokens.addChild(root);
        view = { root, disc, label, key: '' };
        this.tokenViews.set(o.id, view);
      }
      if (view.key !== key) {
        view.key = key;
        const d = view.disc;
        d.clear();
        const fill = hex(o.appearance.tint, 0x6b6580);
        const ring = TYPE_RING[o.objectType] ?? 0xffffff;
        const lw = Math.max(1.5, r * 0.12);
        // Shape varies by type so tokens are distinguishable without colour.
        if (o.objectType === 'LOOT' || o.objectType === 'PROP') d.roundRect(-r, -r, r * 2, r * 2, r * 0.25);
        else if (o.objectType === 'CREATURE') d.regularPoly(0, 0, r * 1.08, 6, Math.PI / 6);
        else if (o.objectType === 'PIN') d.star(0, 0, 5, r, r * 0.5);
        else d.circle(0, 0, r);
        d.fill({ color: fill, alpha: hidden ? 0.55 : 1 }).stroke({ width: lw, color: ring, alpha: 1 });
        if (ctx.selectedId === o.id) d.circle(0, 0, r + lw * 2.2).stroke({ width: lw, color: 0xffffff, alpha: 0.9 });
        if (o.assignedControllerSub === ctx.mySub) d.circle(0, 0, r * 0.22).fill({ color: 0xffffff, alpha: 0.9 });
        if (hidden) d.moveTo(-r * 0.7, -r * 0.7).lineTo(r * 0.7, r * 0.7).stroke({ width: lw, color: 0xffffff, alpha: 0.7 });
        // GM-only HP bar (only GMs receive gmStats).
        if (hp && hp.max > 0) {
          const frac = Math.max(0, Math.min(1, hp.current / hp.max));
          const w = r * 1.8;
          const bh = Math.max(2, r * 0.18);
          d.rect(-w / 2, -r - bh * 2.2, w, bh).fill({ color: 0x000000, alpha: 0.7 });
          d.rect(-w / 2, -r - bh * 2.2, w * frac, bh).fill({ color: frac > 0.5 ? 0x46a758 : frac > 0.25 ? 0xf3a712 : 0xe5484d });
        }
        const suffix = o.visibility === 'GM_ONLY' ? ' (hidden)' : o.visibility === 'SELECTED_PLAYERS' ? ' (some)' : '';
        const conditions = o.conditions?.length ? `\n${o.conditions.join(' · ')}` : '';
        view.label.text = (o.appearance.label ?? '') + suffix + conditions;
        view.label.position.set(0, r + 3);
      }
      view.root.position.set(o.x, o.y);
      view.root.zIndex = o.zIndex;
    }
    for (const [id, v] of this.tokenViews) {
      if (!keep.has(id)) {
        v.root.destroy({ children: true });
        this.tokenViews.delete(id);
      }
    }
    this.rescaleLabels();
  }

  private rescaleLabels() {
    const s = Math.min(4, 1 / this.camera.zoom);
    for (const v of this.tokenViews.values()) {
      v.label.scale.set(s);
      v.label.visible = this.camera.zoom > 0.08;
    }
  }

  /** Hit test in map coordinates, topmost first. */
  hitTest(p: Point, objects: TableObject[]): TableObject | null {
    return this.hitTestAll(p, objects)[0] ?? null;
  }

  /** Every token under the point, topmost first (for picking out of a stack). */
  hitTestAll(p: Point, objects: TableObject[]): TableObject[] {
    return [...objects]
      .sort((a, b) => b.zIndex - a.zIndex)
      .filter((o) => {
        const r = this.tokenRadius(o) * 1.1;
        return (p.x - o.x) ** 2 + (p.y - o.y) ** 2 <= r * r;
      });
  }

  moveTokenView(id: string, x: number, y: number) {
    this.tokenViews.get(id)?.root.position.set(x, y);
  }

  refresh() {
    this.setObjects(this.lastObjects, this.lastCtx);
  }

  // -------------------------------------------------------------- overlay

  setOverlay(o: Overlay) {
    const g = this.overlayG;
    g.clear();
    const lw = 2 / this.camera.zoom;
    this.overlayText.text = '';
    if (o.ruler) {
      const { a, b } = o.ruler;
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: lw * 1.5, color: 0xc9a24a });
      g.circle(a.x, a.y, 4 / this.camera.zoom).fill(0xc9a24a);
      g.circle(b.x, b.y, 4 / this.camera.zoom).fill(0xc9a24a);
      const s = mapToScreen(b, this.camera);
      this.overlayText.text = o.ruler.label;
      this.overlayText.position.set(s.x + 12, s.y - 24);
    }
    if (o.fogRect) {
      const { a, b, mode } = o.fogRect;
      g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        .fill({ color: mode === 'reveal' ? 0xffffff : 0x000000, alpha: 0.2 })
        .stroke({ width: lw, color: mode === 'reveal' ? 0xc9a24a : 0x8e8aa0 });
    }
    if (o.fogBrush && o.fogBrush.points.length) {
      const pts = o.fogBrush.points;
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
      g.stroke({ width: o.fogBrush.radius * 2, color: o.fogBrush.mode === 'reveal' ? 0xffffff : 0x000000, alpha: 0.25, cap: 'round', join: 'round' });
    }
  }

  // -------------------------------------------------------- cursors/pings

  setCursors(cursors: RemoteCursor[], visible: boolean) {
    const map = this.map;
    const keep = new Set<string>();
    if (visible && map) {
      for (const c of cursors) {
        keep.add(c.sub);
        let view = this.cursorViews.get(c.sub);
        if (!view) {
          view = new Container();
          const arrow = new Graphics().poly([0, 0, 0, 18, 5, 14, 9, 22, 12, 21, 8, 13, 14, 13], true).fill(hex(c.color, 0xffffff)).stroke({ width: 1.5, color: 0x000000 });
          const tag = new Text({ text: c.name, style: { fontFamily: 'Inter', fontSize: 12, fill: 0xffffff, fontWeight: '600' } });
          const bg = new Graphics().roundRect(0, 0, tag.width + 10, tag.height + 4, 4).fill({ color: hex(c.color, 0x333333), alpha: 0.95 });
          bg.position.set(14, 18);
          tag.position.set(19, 20);
          view.addChild(arrow, bg, tag);
          this.cursorLayer.addChild(view);
          this.cursorViews.set(c.sub, view);
        }
        const s = mapToScreen({ x: c.nx * map.widthPx, y: c.ny * map.heightPx }, this.camera);
        view.position.set(s.x, s.y);
      }
    }
    for (const [sub, v] of this.cursorViews) {
      if (!keep.has(sub)) {
        v.destroy({ children: true });
        this.cursorViews.delete(sub);
      }
    }
  }

  private pings: Ping[] = [];
  setPings(p: Ping[]) {
    this.pings = p;
  }

  private animatePings() {
    const g = this.pingG;
    g.clear();
    const now = Date.now();
    for (const p of this.pings) {
      const t = (now - p.at) / 2500;
      if (t > 1) continue;
      const s = mapToScreen(p, this.camera);
      for (let k = 0; k < 2; k++) {
        const tt = (t * 2 + k * 0.5) % 1;
        g.circle(s.x, s.y, 8 + tt * 46).stroke({ width: 3, color: hex(p.color, 0xffffff), alpha: (1 - tt) * (1 - t) });
      }
      g.circle(s.x, s.y, 5).fill({ color: hex(p.color, 0xffffff), alpha: 1 - t });
    }
  }
}

function traceShape(ctx: CanvasRenderingContext2D, shape: FogShape, k: number) {
  switch (shape.kind) {
    case 'rect':
      ctx.fillRect(shape.x * k, shape.y * k, shape.w * k, shape.h * k);
      return;
    case 'polygon':
      ctx.beginPath();
      shape.points.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)));
      ctx.closePath();
      ctx.fill();
      return;
    case 'brush':
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = shape.radius * 2 * k;
      ctx.beginPath();
      shape.points.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)));
      if (shape.points.length === 1) {
        ctx.arc(shape.points[0]!.x * k, shape.points[0]!.y * k, shape.radius * k, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.stroke();
      return;
  }
}
