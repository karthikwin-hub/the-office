/**
 * The sky over the office, worked out in the browser: where the sun and moon are, when
 * the sun rises and sets, and what colour the sky is. Pure maths, no three.js, so the
 * engine tests can check it against known values.
 */

const RAD = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export type SunPosition = {
  /** Degrees above the horizon. */ el: number /** Degrees from north, clockwise. */;
  az: number /** Hour angle, radians. */;
  ha: number;
  decl: number;
  eqTime: number;
};

/** The sun's position for a moment and place, after NOAA's solar calculator (good to a fraction of a degree). */
export function sunAt(date: Date, lat: number, lon: number): SunPosition {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const eqTime =
    (4 / RAD) *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const ha = ((utcMinutes + eqTime + 4 * lon) / 4 - 180) * RAD;
  return { ...altAz(ha, decl, lat), ha, decl, eqTime };
}

/** Height and bearing of a body from its hour angle and declination. */
export function altAz(ha: number, decl: number, lat: number): { el: number; az: number } {
  const phi = lat * RAD;
  const el = Math.asin(clamp(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha), -1, 1));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI;
  return { el: el / RAD, az: (az / RAD + 360) % 360 };
}

/** Sunrise and sunset in minutes after midnight UTC, for the UTC day starting at `dayUtc`. */
export function sunTimes(dayUtc: number, lat: number, lon: number): { rise: number; set: number } {
  const s = sunAt(new Date(dayUtc + 6.5 * 3_600_000), lat, lon);
  const phi = lat * RAD;
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(s.decl)) / (Math.cos(phi) * Math.cos(s.decl));
  const H = Math.acos(clamp(cosH, -1, 1)) / RAD;
  const noon = 720 - 4 * lon - s.eqTime;
  return { rise: noon - 4 * H, set: noon + 4 * H };
}

/** 0 at new moon, 0.5 at full. */
export function moonPhase(date: Date): number {
  const p = ((date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000 / 29.530588853) % 1;
  return p < 0 ? p + 1 : p;
}
export const PHASE_NAMES = [
  "new moon",
  "waxing crescent",
  "first quarter",
  "waxing gibbous",
  "full moon",
  "waning gibbous",
  "last quarter",
  "waning crescent",
] as const;
export const phaseName = (p: number) => PHASE_NAMES[Math.round(p * 8) % 8]!;

/** Roughly where the moon is: it trails the sun by its phase. Good enough to hang it in the painted sky. */
export function moonAt(sun: SunPosition, phase: number, lat: number): { el: number; az: number } {
  return altAz(sun.ha - phase * Math.PI * 2, sun.decl * Math.cos(phase * Math.PI * 2), lat);
}

/**
 * A direction in the scene. The far edge of the page faces south, so east is to the left
 * and the sun crosses the backdrop from left to right.
 */
export function sceneDirection(az: number, el: number): { x: number; y: number; z: number } {
  const ce = Math.cos(el * RAD);
  return { x: -Math.sin(az * RAD) * ce, y: Math.sin(el * RAD), z: Math.cos(az * RAD) * ce };
}

/** India time, the only clock the office keeps. */
export const IST_MINUTES = 330;
export function istParts(t: number): { day: number; minutes: number } {
  const d = new Date(t + IST_MINUTES * 60_000);
  return { day: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 };
}
/** "4:12 pm" for minutes after midnight in India. */
export function clockText(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60),
    mm = Math.floor(m % 60);
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const SKY: [number, string, string][] = [
  [-18, "#070d1f", "#0f1a33"],
  [-8, "#101b3c", "#2b3561"],
  [-3, "#26386b", "#a8667a"],
  [1, "#4f6fa8", "#f2a36b"],
  [6, "#7aa3d4", "#f7cf98"],
  [15, "#8ab8e6", "#dfeaf2"],
  [40, "#79aee6", "#e6f0f6"],
];
/** The painted sky, top and horizon, in 0–255 sRGB: dawn pink, white noon, amber dusk, indigo night. A hot day bleaches the horizon. */
export function skyColours(el: number, hot = false): { top: Rgb; horizon: Rgb } {
  let i = 0;
  while (i < SKY.length - 2 && el > SKY[i + 1]![0]) i++;
  const [e0, t0, b0] = SKY[i]!,
    [e1, t1, b1] = SKY[i + 1]!;
  const t = clamp((el - e0) / (e1 - e0), 0, 1);
  const top = mix(hex(t0), hex(t1), t);
  let horizon = mix(hex(b0), hex(b1), t);
  if (hot) horizon = mix(horizon, hex("#f3d9a4"), 0.3 * smooth(0, 10, el));
  return { top, horizon };
}

/** How much daylight: 0 at night, 1 by mid-morning. */
export const daylight = (el: number) => smooth(-8, 10, el);
/** How far the lamps are on: at dusk and through the night. */
export const lampsOn = (el: number) => 1 - smooth(-4, 7, el);

/** Each GST state's capital, so the sun is in the right place even when the weather cannot be fetched. */
export const STATE_CAPITALS: Record<string, [lat: number, lon: number]> = {
  "01": [34.08, 74.8],
  "02": [31.1, 77.17],
  "03": [30.73, 76.78],
  "04": [30.73, 76.78],
  "05": [30.32, 78.03],
  "06": [30.73, 76.78],
  "07": [28.61, 77.21],
  "08": [26.91, 75.79],
  "09": [26.85, 80.95],
  "10": [25.59, 85.14],
  "11": [27.33, 88.61],
  "12": [27.08, 93.61],
  "13": [25.67, 94.11],
  "14": [24.82, 93.94],
  "15": [23.73, 92.72],
  "16": [23.83, 91.29],
  "17": [25.58, 91.89],
  "18": [26.14, 91.79],
  "19": [22.57, 88.36],
  "20": [23.34, 85.31],
  "21": [20.3, 85.82],
  "22": [21.25, 81.63],
  "23": [23.26, 77.41],
  "24": [23.22, 72.64],
  "25": [20.4, 72.83],
  "26": [20.27, 73.01],
  "27": [19.08, 72.88],
  "28": [16.51, 80.52],
  "29": [12.97, 77.59],
  "30": [15.49, 73.83],
  "31": [10.57, 72.64],
  "32": [8.52, 76.94],
  "33": [13.08, 80.27],
  "34": [11.94, 79.81],
  "35": [11.62, 92.73],
  "36": [17.39, 78.49],
  "37": [16.51, 80.52],
  "38": [34.15, 77.58],
};
/** The middle of India, when nothing better is known. */
export const INDIA: [number, number] = [21.15, 79.09];
export function whereIs(weather: { lat?: number; lon?: number } | null | undefined, stateCode: string | undefined): [number, number] {
  if (weather && typeof weather.lat === "number" && typeof weather.lon === "number") return [weather.lat, weather.lon];
  return (stateCode && STATE_CAPITALS[stateCode]) || INDIA;
}

/** Where to print each hour on the sundial for a day: the lamp post's shadow points there at that hour. */
export function sundialMarks(dayUtc: number, lat: number, lon: number, radius = 6.4): { hour: number; dx: number; dz: number }[] {
  const out: { hour: number; dx: number; dz: number }[] = [];
  for (let h = 6; h <= 18; h++) {
    const s = sunAt(new Date(dayUtc + (h * 60 - IST_MINUTES) * 60_000), lat, lon);
    if (s.el < 4) continue;
    const d = sceneDirection(s.az, s.el),
      len = Math.hypot(d.x, d.z);
    out.push({ hour: h, dx: (-d.x / len) * radius, dz: (-d.z / len) * radius });
  }
  return out;
}
