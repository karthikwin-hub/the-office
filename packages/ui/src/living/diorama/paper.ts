import * as THREE from "three";

/**
 * The stuff the office is made of: card, ink and paper. Every texture is drawn once on a
 * canvas, so there are no image files to fetch, and every material is a plain Lambert,
 * which keeps the number of shaders small and the first frame quick.
 */

export const HAND = "Kalam, 'Segoe Print', 'Comic Sans MS', cursive";
export const PRINT = "'Atkinson Hyperlegible Next', system-ui, sans-serif";
export const INK = "#4f463c";

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;
export type DrawnTexture = THREE.CanvasTexture & { redraw: () => void };

/** A texture drawn on a canvas, redrawable when the fonts arrive or the office changes. */
export function drawn(w: number, h: number, draw: Draw, opts: { srgb?: boolean; repeat?: [number, number]; anisotropy?: number } = {}): DrawnTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const run = () => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.textAlign = "left";
    draw(g, w, h);
  };
  run();
  const t = new THREE.CanvasTexture(c) as DrawnTexture;
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.anisotropy) t.anisotropy = opts.anisotropy;
  if (opts.repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...opts.repeat);
  }
  t.redraw = () => {
    run();
    t.needsUpdate = true;
  };
  return t;
}

let fibreTile: HTMLCanvasElement | null = null;
/** Paper fibres: one small tile of strokes, repeated, instead of drawing every stroke at full size. */
export function fibres(g: CanvasRenderingContext2D, w: number, h: number, strength = 1) {
  if (!fibreTile) {
    fibreTile = document.createElement("canvas");
    fibreTile.width = fibreTile.height = 256;
    const t = fibreTile.getContext("2d")!;
    const r = rng(3);
    for (let i = 0; i < (256 * 256) / 55; i++) {
      const x = r() * 256, y = r() * 256, a = r() * Math.PI, l = 2 + r() * 7;
      t.strokeStyle = `rgba(${r() < 0.5 ? "120,100,80" : "255,255,255"},${0.05 + r() * 0.07})`;
      t.lineWidth = 0.6 + r() * 0.6;
      t.beginPath();
      t.moveTo(x, y);
      t.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      t.stroke();
    }
  }
  g.save();
  g.globalAlpha = Math.min(1, strength);
  g.fillStyle = g.createPattern(fibreTile, "repeat")!;
  g.fillRect(0, 0, w, h);
  g.restore();
}

/** Leaves for the neem tree, the tulsi and the office plants, drawn as a cut-out. */
export function leafy(seed: number): Draw {
  return (g, w, h) => {
    const r = rng(seed);
    for (let i = 0; i < 70; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.42;
      g.fillStyle = ["#5d7e3f", "#6f8f4e", "#7f9f57", "#4f6e36"][Math.floor(r() * 4)]!;
      g.beginPath();
      g.ellipse(w * (0.5 + Math.cos(a) * d), h * (0.45 + Math.sin(a) * d * 0.8), w * 0.09, h * 0.07, r() * 3, 0, 7);
      g.fill();
    }
  };
}

export type Kit = ReturnType<typeof makeKit>;

/** The shared materials and builders for one office. */
export function makeKit(anisotropy: number) {
  const fibre = drawn(256, 256, (g, w, h) => {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    fibres(g, w, h, 1.6);
  }, { repeat: [2, 2] });
  const lambert = (color: string, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, map: fibre, ...extra });
  const M = {
    wall: lambert("#f3eee4"),
    poche: new THREE.MeshLambertMaterial({ color: "#4a4038" }),
    edge: new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.5 }),
    desk: lambert("#d9c4a1"),
    wood: lambert("#a9774c"),
    chair: lambert("#7a3e2b"),
    sheet: new THREE.MeshLambertMaterial({ color: "#fffdf7", side: THREE.DoubleSide }),
    ink: new THREE.MeshLambertMaterial({ color: "#3a332c" }),
    brass: new THREE.MeshLambertMaterial({ color: "#c49a45" }),
    pot: lambert("#b3653f"),
    screen: new THREE.MeshLambertMaterial({ color: "#2b3440", emissive: "#6fa0d8", emissiveIntensity: 0.25 }),
    lampShade: new THREE.MeshLambertMaterial({ color: "#f3d39b", emissive: "#ffb85c", emissiveIntensity: 0 }),
    highlight: new THREE.MeshBasicMaterial({ color: "#f5e15a", transparent: true, opacity: 0.85 }),
  };
  const boxMats = (side: THREE.Material, top: THREE.Material = M.poche) => [side, side, top, side, side, side];

  function edged<T extends THREE.Mesh>(mesh: T): T {
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 20), M.edge));
    return mesh;
  }
  /** A box standing on the floor at (x, y, z), its base at y. */
  function box(w: number, h: number, d: number, mat: THREE.Material | THREE.Material[], o: { x?: number; y?: number; z?: number; edges?: boolean; cast?: boolean } = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0, h / 2, 0);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    m.castShadow = o.cast !== false;
    m.receiveShadow = true;
    return o.edges === false ? m : edged(m);
  }
  function cyl(rt: number, rb: number, h: number, mat: THREE.Material, seg = 16, o: { x?: number; y?: number; z?: number; cast?: boolean } = {}) {
    const geo = new THREE.CylinderGeometry(rt, rb, h, seg);
    geo.translate(0, h / 2, 0);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    m.castShadow = o.cast !== false;
    m.receiveShadow = true;
    return m;
  }
  /** A standing cut-out card, as in a pop-up book: a drawn silhouette on a plane. */
  function cutout(w: number, h: number, draw: Draw, cast = true) {
    const tex = drawn(256, Math.round((256 * h) / w), draw);
    const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
    const geo = new THREE.PlaneGeometry(w, h);
    geo.translate(0, h / 2, 0);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5 });
    return m;
  }
  const steamTex = drawn(64, 64, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, "rgba(255,255,255,.9)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
  });
  const glowTex = drawn(128, 128, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, "rgba(255,196,120,1)");
    gr.addColorStop(0.45, "rgba(255,170,90,.45)");
    gr.addColorStop(1, "rgba(255,160,80,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, w);
  });
  return { anisotropy, fibre, M, boxMats, edged, box, cyl, cutout, steamTex, glowTex };
}
