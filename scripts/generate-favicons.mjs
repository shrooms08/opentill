#!/usr/bin/env node
/**
 * Generates the raster favicons from the canonical OpenTill mark geometry:
 *   apps/web/public/favicon-16.png   (small-size variant paths)
 *   apps/web/public/favicon-32.png   (standard mark)
 *   apps/web/public/favicon-48.png   (standard mark)
 *   apps/web/public/favicon.ico     (the three PNGs in an ICO container)
 *
 * The outputs are CHECKED IN (deterministic, no build-time native dep); rerun
 * this script only when the mark changes:  node scripts/generate-favicons.mjs
 *
 * Raster fallbacks can't adapt to the tab theme, so they use the ink tray
 * (#0a0a0a) — legacy consumers default to light UI; modern browsers pick the
 * theme-aware favicon.svg instead. Coin is always #f7931a.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const out = (f) => fileURLToPath(new URL(`../apps/web/public/${f}`, import.meta.url));

const COIN = "#f7931a";
const TRAY = "#0a0a0a";

/** Standard mark. */
const STD = `<circle cx="12" cy="5.5" r="4" fill="${COIN}"/>
  <path fill-rule="evenodd" d="M3 11h3v7h12v-7h3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="${TRAY}"/>`;

/** Small-size variant (≤16px rendered) — optical compensation, 16px layer only. */
const SMALL = `<circle cx="12" cy="5.5" r="4.5" fill="${COIN}"/>
  <path fill-rule="evenodd" d="M2.5 11h3.5v6.5h12V11h3.5v7a3 3 0 0 1-3 3H5.5a3 3 0 0 1-3-3z" fill="${TRAY}"/>`;

const svg = (shapes) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${shapes}</svg>`);

async function png(shapes, size) {
  return sharp(svg(shapes), { density: (72 * size) / 24 }).resize(size, size).png().toBuffer();
}

/** Minimal ICO container with PNG-encoded entries (supported by all modern consumers). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size === 256 ? 0 : size, o); // width
    dir.writeUInt8(size === 256 ? 0 : size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

const p16 = await png(SMALL, 16);
const p32 = await png(STD, 32);
const p48 = await png(STD, 48);

await writeFile(out("favicon-16.png"), p16);
await writeFile(out("favicon-32.png"), p32);
await writeFile(out("favicon-48.png"), p48);
await writeFile(
  out("favicon.ico"),
  buildIco([
    { size: 16, data: p16 },
    { size: 32, data: p32 },
    { size: 48, data: p48 },
  ]),
);

console.log("wrote favicon-16/32/48.png + favicon.ico to apps/web/public/");
