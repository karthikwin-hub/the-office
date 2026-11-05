import type { SkinId } from "@office/contracts";

/**
 * How one office looks. Everything a skin changes is a CSS custom property, so a
 * skin can be applied to the whole page or to one preview. The layout, the type
 * and the words never change.
 */
export type Skin = {
  id: SkinId;
  name: string;
  description: string;
  dark?: boolean;
  tokens: {
    paper: string;
    carbon: string;
    onCarbon: string;
    graphite: string;
    planLine: string;
    stampRed: string;
    clearedGreen: string;
    /** Mixed 70% into the paper for cards, rooms and inputs. */
    sheetBase: string;
    /** The floor between the rooms. */
    floor: string;
    wallInk: string;
    roomLine: string;
    wall: string;
    furnitureLine: string;
    furnitureFill: string;
    deskRadius: string;
    nameplate: string;
    textureInk: string;
    textureOpacity: number;
  };
  /** A tile drawn faintly across the floor: wood grain, carpet, ledger rules, brick. */
  texture: { size: number; d: string };
};

export const SKINS: Skin[] = [
  {
    id: "blueprint",
    name: "Blueprint",
    description: "An architect's plan: clean lines on drafting paper.",
    tokens: {
      paper: "#f3f5f7",
      carbon: "#27408b",
      onCarbon: "#ffffff",
      graphite: "#2a2d31",
      planLine: "#b4bcc6",
      stampRed: "#b42318",
      clearedGreen: "#2f6b3f",
      sheetBase: "#ffffff",
      floor: "transparent",
      wallInk: "#2a2d31",
      roomLine: "#6a6e74",
      wall: "2px",
      furnitureLine: "#c9cfd6",
      furnitureFill: "none",
      deskRadius: "2px",
      nameplate: "transparent",
      textureInk: "#2a2d31",
      textureOpacity: 0,
    },
    texture: { size: 24, d: "M 0 24 L 24 0" },
  },
  {
    id: "open-plan",
    name: "Open plan",
    description: "Warm oak floors, glass walls and round desks.",
    tokens: {
      paper: "#f7f4ee",
      carbon: "#1d6762",
      onCarbon: "#ffffff",
      graphite: "#2b2a27",
      planLine: "#cfc4b1",
      stampRed: "#b3261e",
      clearedGreen: "#2e6b3a",
      sheetBase: "#fffdf8",
      floor: "#efe6d6",
      wallInk: "#5d564b",
      roomLine: "#7fb3ae",
      wall: "1.5px",
      furnitureLine: "#bba98c",
      furnitureFill: "#f4ecdf",
      deskRadius: "15px",
      nameplate: "transparent",
      textureInk: "#5d4a2a",
      textureOpacity: 0.04,
    },
    texture: { size: 40, d: "M 0 10 C 10 7, 30 13, 40 10 M 0 30 C 12 33, 28 27, 40 30" },
  },
  {
    id: "cubicles",
    name: "Cubicles",
    description: "A classic office: carpet tiles, partitions and a nameplate on every desk.",
    tokens: {
      paper: "#eef1ee",
      carbon: "#2f5d50",
      onCarbon: "#ffffff",
      graphite: "#262a28",
      planLine: "#a9b5ad",
      stampRed: "#a8241b",
      clearedGreen: "#2d6a3c",
      sheetBase: "#ffffff",
      floor: "#dfe5df",
      wallInk: "#3a423e",
      roomLine: "#6f7c74",
      wall: "4px",
      furnitureLine: "#9aa79f",
      furnitureFill: "#e9eee9",
      deskRadius: "1px",
      nameplate: "#e2e8e3",
      textureInk: "#26302b",
      textureOpacity: 0.04,
    },
    texture: { size: 16, d: "M 0 0 H 16 V 16 M 0 8 H 8 V 16" },
  },
  {
    id: "counting-house",
    name: "Counting house",
    description: "A bahi-khata office: cream ledger paper, red cloth and gold thread.",
    tokens: {
      paper: "#f6efdf",
      carbon: "#23395b",
      onCarbon: "#ffffff",
      graphite: "#2e2620",
      planLine: "#cdb27a",
      stampRed: "#a3201a",
      clearedGreen: "#2f6338",
      sheetBase: "#fffaf0",
      floor: "#efe3c8",
      wallInk: "#7a1f1a",
      roomLine: "#b08a45",
      wall: "2px",
      furnitureLine: "#9c3a2a",
      furnitureFill: "#f2dcc9",
      deskRadius: "6px",
      nameplate: "transparent",
      textureInk: "#7a1f1a",
      textureOpacity: 0.04,
    },
    texture: { size: 22, d: "M 0 21 H 22 M 6 0 V 22" },
  },
  {
    id: "loft",
    name: "Loft",
    description: "Exposed brick, concrete and black steel, with an amber light.",
    tokens: {
      paper: "#f2f0ee",
      carbon: "#8a4b08",
      onCarbon: "#ffffff",
      graphite: "#1f1f1f",
      planLine: "#b8b2ab",
      stampRed: "#a82a1d",
      clearedGreen: "#2f6a3d",
      sheetBase: "#fbfaf9",
      floor: "#e4e0dc",
      wallInk: "#111111",
      roomLine: "#3d3d3d",
      wall: "2.5px",
      furnitureLine: "#a09a93",
      furnitureFill: "none",
      deskRadius: "0px",
      nameplate: "transparent",
      textureInk: "#6b2f1e",
      textureOpacity: 0.04,
    },
    texture: { size: 24, d: "M 0 0 H 24 M 0 12 H 24 M 12 0 V 12 M 0 12 V 24 M 24 12 V 24" },
  },
  {
    id: "night-shift",
    name: "Night shift",
    description: "Dark and calm for the evening books.",
    dark: true,
    tokens: {
      paper: "#10172a",
      carbon: "#9dbcff",
      onCarbon: "#0b1222",
      graphite: "#e6eaf2",
      planLine: "#3a4766",
      stampRed: "#ff8f85",
      clearedGreen: "#84dca0",
      sheetBase: "#1b2643",
      floor: "transparent",
      wallInk: "#c9d2e6",
      roomLine: "#7d8bab",
      wall: "2px",
      furnitureLine: "#3f4c6d",
      furnitureFill: "none",
      deskRadius: "2px",
      nameplate: "transparent",
      textureInk: "#e6eaf2",
      textureOpacity: 0,
    },
    texture: { size: 24, d: "M 0 24 L 24 0" },
  },
];

export const SKIN_BY_ID = Object.fromEntries(SKINS.map((s) => [s.id, s])) as Record<SkinId, Skin>;
export const DEFAULT_SKIN = SKIN_BY_ID.blueprint;

/** The skin as CSS custom properties, for the page or for a single preview. */
export function skinStyle(skin: Skin): Record<string, string> {
  const t = skin.tokens;
  return {
    "--paper": t.paper,
    "--carbon": t.carbon,
    "--on-carbon": t.onCarbon,
    "--graphite": t.graphite,
    "--plan-line": t.planLine,
    "--stamp-red": t.stampRed,
    "--cleared-green": t.clearedGreen,
    "--sheet-base": t.sheetBase,
    "--floor": t.floor,
    "--wall-ink": t.wallInk,
    "--room-line": t.roomLine,
    "--wall": t.wall,
    "--furniture-line": t.furnitureLine,
    "--furniture-fill": t.furnitureFill,
    "--desk-radius": t.deskRadius,
    "--nameplate": t.nameplate,
    "--texture-ink": t.textureInk,
    "--texture-opacity": String(t.textureOpacity),
    "color-scheme": skin.dark ? "dark" : "light",
  };
}

/** Where the page keeps the applied skin, so index.html can paint it before React starts. */
export const SKIN_CACHE = "office.skin.style";

/** Puts a skin on the whole page and remembers it for the next load on this machine. */
export function applySkin(skin: Skin, el: HTMLElement = document.documentElement) {
  const style = skinStyle(skin);
  for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v);
  el.dataset.skin = skin.id;
  try {
    localStorage.setItem(SKIN_CACHE, JSON.stringify({ id: skin.id, style }));
  } catch {
    /* private browsing: the skin still applies, it just is not cached */
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", skin.tokens.paper);
}

/* ---------- Contrast, as WCAG 2.2 defines it ---------- */

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const hex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

/** `color-mix(in srgb, a p%, b)`. */
export function mix(a: string, p: number, b: string): string {
  const [x, y] = [rgb(a), rgb(b)];
  return hex([0, 1, 2].map((i) => x[i]! * p + y[i]! * (1 - p)) as [number, number, number]);
}

export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** The pairs every skin must keep readable, each with the WCAG AA ratio it needs. */
export function contrastPairs(skin: Skin): { name: string; fg: string; bg: string; min: number }[] {
  const t = skin.tokens;
  const sheet = mix(t.sheetBase, 0.7, t.paper);
  const soft = mix(t.graphite, 0.68, t.paper);
  const carbonTint = mix(t.carbon, 0.09, t.paper);
  return [
    { name: "text on paper", fg: t.graphite, bg: t.paper, min: 4.5 },
    { name: "text on cards", fg: t.graphite, bg: sheet, min: 4.5 },
    { name: "quiet text on paper", fg: soft, bg: t.paper, min: 4.5 },
    { name: "links on paper", fg: t.carbon, bg: t.paper, min: 4.5 },
    { name: "links on cards", fg: t.carbon, bg: sheet, min: 4.5 },
    { name: "text in a working room", fg: t.graphite, bg: carbonTint, min: 4.5 },
    { name: "button text", fg: t.onCarbon, bg: t.carbon, min: 4.5 },
    { name: "red figures on cards", fg: t.stampRed, bg: sheet, min: 4.5 },
    { name: "green figures on cards", fg: t.clearedGreen, bg: sheet, min: 4.5 },
    { name: "focus ring", fg: t.carbon, bg: t.paper, min: 3 },
    { name: "outer walls", fg: t.wallInk, bg: t.paper, min: 3 },
  ];
}
