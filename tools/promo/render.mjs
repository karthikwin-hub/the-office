#!/usr/bin/env node
// Renders tools/promo/promo.html to MP4, frame by frame, in each shape.
//
//   FFMPEG=/path/to/ffmpeg node tools/promo/render.mjs [wide,vertical,square]
//
// Every frame is drawn from its time alone, so the three videos match exactly.
// Output goes to tools/promo/out/.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const FPS = 30;
const SHAPES = { wide: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080] };
const here = import.meta.dirname;
const out = join(here, "out");
await mkdir(out, { recursive: true });
const shapes = (process.argv[2] ?? Object.keys(SHAPES).join(",")).split(",");

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
for (const shape of shapes) {
  const [width, height] = SHAPES[shape];
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${pathToFileURL(resolve(here, "promo.html")).href}?t=0`);
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const file = join(out, `agentic-office-${shape}.mp4`);
  const ffmpeg = spawn(process.env.FFMPEG ?? "ffmpeg", [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p",
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", file,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((ok, fail) => ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)))));
  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    const jpg = await page.screenshot({ type: "jpeg", quality: 94 });
    if (!ffmpeg.stdin.write(jpg)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (i % (FPS * 10) === 0) console.log(`${shape}: ${Math.round(i / FPS)}s of ${duration}s`);
  }
  ffmpeg.stdin.end();
  await done;
  await page.close();
  console.log(`wrote ${file}`);
}
await browser.close();
