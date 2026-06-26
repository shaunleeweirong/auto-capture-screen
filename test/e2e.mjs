// End-to-end test for Guidely's capture pipeline, with emphasis on the
// regression that broke v0.1.0: capture must survive full-page navigation.
//
// Run with:  npm run test:e2e
// (the npm script builds the development extension first, which includes the
//  __guidelyTestStart hook used here to start recording without a toolbar click)
//
// It launches real Chromium with the extension loaded, drives clicks across two
// pages (with a navigation in between), and asserts that steps from BOTH pages
// were captured and stored in IndexedDB.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, 'site');
const EXT = resolve(__dirname, '..', 'dist', 'chrome-mv3-dev');
const PORT = 8741;
const BASE = `http://localhost:${PORT}`;

if (!existsSync(EXT)) {
  console.error(`Dev build not found at ${EXT}\nRun: npx wxt build --mode development`);
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/page1.html' : req.url.split('?')[0];
    const body = await readFile(join(SITE, path));
    res.writeHead(200, { 'content-type': MIME[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const ctx = await chromium.launchPersistentContext('/tmp/guidely-e2e-profile', {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let code = 0;

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

  const page = await ctx.newPage();
  await page.goto(`${BASE}/page1.html`, { waitUntil: 'load' });
  await pause(600);

  const ids = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url && t.url.startsWith(url));
    return t ? { tabId: t.id, windowId: t.windowId } : null;
  }, `${BASE}/page1`);
  if (!ids) throw new Error('could not find the test tab');

  await sw.evaluate(({ tabId, windowId }) => globalThis.__guidelyTestStart(tabId, windowId), ids);
  await pause(500);

  const clickWait = async (sel) => {
    await page.click(sel);
    await pause(700); // respect the 2/sec capture throttle
  };

  await clickWait('#a'); // page 1
  await clickWait('#b'); // page 1
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#go')]); // navigates to page 2
  await pause(900); // page 2 content script loads + resumes via GUIDELY_HELLO
  await clickWait('#c'); // page 2
  await clickWait('#d'); // page 2
  await pause(700);

  const diag = await sw.evaluate(() => globalThis.__guidelyDiag());
  const guides = await sw.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('guidely');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise((res, rej) => {
      const t = db.transaction('guides');
      const r = t.objectStore('guides').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return all.map((g) => ({ title: g.title, steps: g.steps.map((s) => ({ text: s.text, url: s.url, w: s.imageW, h: s.imageH })) }));
  });

  console.log('step messages:', diag.steps.length, '| captures:', diag.captures.length, '| errors:', diag.errors.length);
  const g = guides.sort((a, b) => b.steps.length - a.steps.length)[0] || { steps: [] };
  for (const s of g.steps) console.log(`  - "${s.text}" [${s.w}x${s.h}] ${s.url.split('/').pop()}`);

  const p1 = g.steps.filter((s) => s.url.includes('page1')).length;
  const p2 = g.steps.filter((s) => s.url.includes('page2')).length;
  console.log(`RESULT: total=${g.steps.length} page1=${p1} page2=${p2}`);

  const fails = [];
  if (g.steps.length < 4) fails.push(`expected >=4 steps, got ${g.steps.length}`);
  if (p2 < 1) fails.push('no steps captured after navigation (the v0.1.0 bug)');
  if (g.steps.some((s) => !s.w || !s.h)) fails.push('a step is missing screenshot dimensions');
  if (diag.errors.length) fails.push(`capture errors: ${JSON.stringify(diag.errors)}`);

  if (fails.length) {
    console.log('\n❌ FAIL\n - ' + fails.join('\n - '));
    code = 1;
  } else {
    console.log('\n✅ PASS — multi-click capture works and survives navigation');
  }
} catch (e) {
  console.error('TEST ERROR:', e);
  code = 2;
} finally {
  await ctx.close();
  server.close();
}
process.exit(code);
