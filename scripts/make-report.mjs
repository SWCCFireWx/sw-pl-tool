// Builds reports/SWA_PL_latest.pdf (the Briefing page, printed by headless Chromium)
// and reports/SWA_PL_latest.xlsx from data/current.json.
// Run: node scripts/make-report.mjs   (needs the "playwright" package and its Chromium)
import { createRequire } from "module";
import { createServer } from "http";
import { readFile, mkdir, writeFile } from "fs/promises";
import { dirname, join, extname, normalize } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "reports");
await mkdir(outDir, { recursive: true });

// Excel
const C = require(join(root, "js/config.js"));
const calc = require(join(root, "js/calc.js"))(C);
const X = require(join(root, "js/xlsx-lite.js"));
const E = require(join(root, "js/export.js"))(C, calc, X);
const { existsSync } = require("fs");
const state = JSON.parse(await readFile(join(root, existsSync(join(root, "data/current.json")) ? "data/current.json" : "data/seed.json"), "utf8"));
await writeFile(join(outDir, "SWA_PL_latest.xlsx"), Buffer.from(E.workbook(state)));
console.log("Wrote reports/SWA_PL_latest.xlsx");

// PDF: serve the site locally and print the Briefing page
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\.])+/, "") || "index.html";
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const { chromium } = require("playwright");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/?nopull#briefing`);
  await page.waitForSelector(".report");
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.emulateMedia({ media: "print", colorScheme: "light" });
  await page.pdf({ path: join(outDir, "SWA_PL_latest.pdf"), format: "Letter", printBackground: true, preferCSSPageSize: true });
  console.log("Wrote reports/SWA_PL_latest.pdf");
} finally {
  await browser.close();
  server.close();
}
