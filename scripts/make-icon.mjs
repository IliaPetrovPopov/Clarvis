#!/usr/bin/env node
/**
 * Renders the Clarvis app icon.
 *
 * Uses the headless Chromium that Playwright already installed rather than
 * adding an image toolchain: the mark is drawn in the same CSS the product uses,
 * so the icon cannot drift from the brand by being maintained separately.
 */

import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// Resolve Playwright from the workspace package that depends on it.
const require = createRequire(path.join(root, "packages/core/package.json"));

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body { margin:0; width:1024px; height:1024px; }
  body { display:grid; place-items:center; background:#02050a; }
  .plate {
    width:1024px; height:1024px; display:grid; place-items:center;
    background:
      radial-gradient(ellipse 75% 65% at 50% 25%, rgba(34,217,255,.22), transparent 68%),
      linear-gradient(160deg, #0b1c2e 0%, #02060c 72%);
  }
  .mark { position:relative; width:430px; height:430px; }
  .ring, .core {
    position:absolute; inset:0; transform:rotate(45deg);
  }
  .ring {
    border:26px solid #22d9ff;
    box-shadow: 0 0 90px rgba(34,217,255,.85), inset 0 0 60px rgba(34,217,255,.35);
  }
  .core {
    inset:118px; background:#22d9ff;
    box-shadow: 0 0 80px rgba(34,217,255,.95);
  }
  .tick { position:absolute; background:rgba(34,217,255,.55); }
  .t1 { left:0; top:0; width:120px; height:10px; }
  .t2 { left:0; top:0; width:10px; height:120px; }
  .t3 { right:0; bottom:0; width:120px; height:10px; }
  .t4 { right:0; bottom:0; width:10px; height:120px; }
</style></head>
<body><div class="plate">
  <div style="position:relative;width:820px;height:820px;display:grid;place-items:center">
    <span class="tick t1"></span><span class="tick t2"></span>
    <span class="tick t3"></span><span class="tick t4"></span>
    <div class="mark"><div class="ring"></div><div class="core"></div></div>
  </div>
</div></body></html>`;

const SIZES = [16, 32, 64, 128, 256, 512, 1024];

async function main() {
  const { chromium } = require("@playwright/test");
  const out = path.join(root, "build");
  const iconset = path.join(out, "Clarvis.iconset");

  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(HTML);
  const master = path.join(out, "icon-1024.png");
  await page.screenshot({ path: master, omitBackground: false });
  await browser.close();

  // macOS wants both @1x and @2x for every size below the largest.
  for (const size of SIZES) {
    await run("sips", ["-z", String(size), String(size), master, "--out", path.join(iconset, `icon_${size}x${size}.png`)]);
    if (size <= 512) {
      await run("sips", [
        "-z", String(size * 2), String(size * 2), master,
        "--out", path.join(iconset, `icon_${size}x${size}@2x.png`),
      ]);
    }
  }

  await run("iconutil", ["-c", "icns", iconset, "-o", path.join(out, "Clarvis.icns")]);
  console.log(`icon written: ${path.join(out, "Clarvis.icns")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
