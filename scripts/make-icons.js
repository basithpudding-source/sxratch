// Rasterize icon.svg -> PNG app icons (run: npm run icons).
// The TWA/Play Store and most installers want raster PNG icons; the source of
// truth stays the SVG.

import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = await readFile(join(root, "icon.svg"));

for (const size of [192, 512]) {
  const out = join(root, `icon-${size}.png`);
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out);
  console.log("wrote", `icon-${size}.png`);
}
