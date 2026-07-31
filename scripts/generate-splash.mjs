#!/usr/bin/env node
/* global Buffer, console, process */
/**
 * Generates the iOS `apple-touch-startup-image` set into app/public/splash/.
 *
 * iOS shows a startup image only when a `<link rel="apple-touch-startup-image">`
 * media query matches the device *exactly*, so every supported screen needs its
 * own file. The generated set and the link set in app/index.html are two halves
 * of one contract — change DEVICES and update index.html in the same commit.
 *
 * Mark design (deliberately font-free): the launch screen in App.tsx draws a
 * rounded square in `--ai-bg` with a "J" glyph in Geist 600. Rasterising real
 * text would mean resolving a font through librsvg, whose output depends on the
 * fonts installed on the build machine — not reproducible. Instead the mark
 * keeps the rounded square (fill `--ai-bg`, hairline `--ai-border`) and centres
 * a `--primary` bullet, the journal's own signifier for a task. Every value is
 * pure geometry, so the PNGs are byte-identical on any machine.
 *
 * Splash files are deliberately excluded from the service-worker precache (see
 * journalServiceWorkerPlugin in app/vite.config.ts): iOS reads them from the
 * home-screen bookmark, never over fetch, so precaching only wastes budget.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import sharp from 'sharp';

const SPLASH_DIRECTORY = fileURLToPath(new URL('../app/public/splash', import.meta.url));

/** Portrait device pixels and scale factor, matching app/index.html. */
const DEVICES = [
  { width: 750, height: 1334, scale: 2, devices: 'iPhone SE (2nd/3rd gen), iPhone 8' },
  { width: 828, height: 1792, scale: 2, devices: 'iPhone XR, iPhone 11' },
  { width: 1125, height: 2436, scale: 3, devices: 'iPhone X, XS, 11 Pro' },
  { width: 1080, height: 2340, scale: 3, devices: 'iPhone 12 mini, 13 mini' },
  { width: 1170, height: 2532, scale: 3, devices: 'iPhone 12, 12 Pro, 13, 13 Pro, 14' },
  { width: 1179, height: 2556, scale: 3, devices: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { width: 1284, height: 2778, scale: 3, devices: 'iPhone 12/13 Pro Max, 14 Plus' },
  { width: 1290, height: 2796, scale: 3, devices: 'iPhone 14 Pro Max, 15 Plus/Pro Max, 16 Plus' },
  { width: 1206, height: 2622, scale: 3, devices: 'iPhone 16 Pro' },
  { width: 1320, height: 2868, scale: 3, devices: 'iPhone 16 Pro Max' },
  { width: 1620, height: 2160, scale: 2, devices: 'iPad 10.2"' },
  { width: 1640, height: 2360, scale: 2, devices: 'iPad Air 10.9", iPad 10.9"' },
  { width: 1668, height: 2388, scale: 2, devices: 'iPad Pro 11", iPad Air 11"' },
  { width: 2048, height: 2732, scale: 2, devices: 'iPad Pro 12.9"' },
];

/** Logical (CSS) pixels; multiplied by the device scale when rasterised. */
const BACKGROUND = '#16130F'; // --bg-page
const ACCENT = '#E4652E'; // --primary, the source colour of --ai-bg/--ai-border
const MARK_SIZE = 176; // 4x the 44px in-app mark
const MARK_RADIUS_RATIO = 12 / 44;
const MARK_FILL_OPACITY = 0.15; // --ai-bg
const MARK_STROKE_OPACITY = 0.42; // --ai-border
const MARK_STROKE_WIDTH = 2; // the in-app 1px border, kept a hairline at 4x mark size
const BULLET_SIZE = 16; // the in-app 4px bullet, scaled with the mark

function splashSvg({ width, height, scale }) {
  const mark = MARK_SIZE * scale;
  const markX = (width - mark) / 2;
  const markY = (height - mark) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${BACKGROUND}"/>
  <rect x="${markX}" y="${markY}" width="${mark}" height="${mark}" rx="${mark * MARK_RADIUS_RATIO}" fill="${ACCENT}" fill-opacity="${MARK_FILL_OPACITY}" stroke="${ACCENT}" stroke-opacity="${MARK_STROKE_OPACITY}" stroke-width="${MARK_STROKE_WIDTH * scale}"/>
  <circle cx="${width / 2}" cy="${height / 2}" r="${(BULLET_SIZE * scale) / 2}" fill="${ACCENT}"/>
</svg>`;
}

function splashFileName({ width, height }) {
  return `${width}x${height}.png`;
}

async function generate() {
  await mkdir(SPLASH_DIRECTORY, { recursive: true });
  const expected = new Set(DEVICES.map((device) => splashFileName(device)));
  for (const stale of await readdir(SPLASH_DIRECTORY)) {
    if (!expected.has(stale)) await rm(resolve(SPLASH_DIRECTORY, stale), { recursive: true });
  }
  for (const device of DEVICES) {
    const png = await sharp(Buffer.from(splashSvg(device)))
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    await writeFile(resolve(SPLASH_DIRECTORY, splashFileName(device)), png);
  }
  return DEVICES.length;
}

const count = await generate().catch((error) => {
  console.error(`Splash generation failed: ${String(error)}`);
  process.exit(1);
});
console.log(`Wrote ${count} launch images to app/public/splash/.`);
