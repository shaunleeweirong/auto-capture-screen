// End-to-end test for Guidely's capture pipeline. Covers the two regressions
// this project hit:
//   1. capture must survive SAME-TAB navigation (v0.1.0 bug)
//   2. capture must continue when a link opens a NEW TAB in the same window
//
// Run with:  npm run test:e2e
// (the npm script builds the development extension first, which includes the
//  __guidelyTestStart hook used here to start recording without a toolbar click)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, 'site');
const EXT = resolve(__dirname, '..', 'dist', 'chrome-mv3-dev');
const PROFILE = '/tmp/guidely-e2e-profile';
const PORT = 8741;
const BASE = `http://localhost:${PORT}`;

if (!existsSync(EXT)) {
  console.error(`Dev build not found at ${EXT}\nRun: npx wxt build --mode development`);
  process.exit(2);
}

// Fresh profile each run so stored guides never carry over between runs.
rmSync(PROFILE, { recursive: true, force: true });

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

const ctx = await chromium.launchPersistentContext(PROFILE, {
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
  console.log('start tab:', ids);

  const startRes = await sw.evaluate(({ tabId, windowId }) => globalThis.__guidelyTestStart(tabId, windowId), ids);
  const guideId = startRes?.guideId;
  await pause(500);

  // bringToFront before each click so captureVisibleTab targets the right tab.
  const clickWait = async (target, sel) => {
    await target.bringToFront();
    await target.click(sel);
    await pause(700); // respect the 2/sec capture throttle
  };

  // --- Page 1 (tab A) ---
  await clickWait(page, '#a');
  await clickWait(page, '#b');

  // --- Same-tab navigation to page 2 (tab A) ---
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#go')]);
  await pause(900); // content script reloads + resumes via GUIDELY_HELLO
  await clickWait(page, '#c');

  // --- New tab in the same window (tab B) — the reported bug ---
  await page.goto(`${BASE}/page1.html`, { waitUntil: 'load' });
  await pause(700);
  const [newPage] = await Promise.all([ctx.waitForEvent('page'), page.click('#newtab')]);
  await newPage.waitForLoadState('load');
  await pause(1000); // new tab's content script loads + resumes via GUIDELY_HELLO
  await clickWait(newPage, '#c');
  await clickWait(newPage, '#d');
  await pause(700);

  const diag = await sw.evaluate(() => globalThis.__guidelyDiag());
  const g = await sw.evaluate(async (gid) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('guidely');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const guide = await new Promise((res, rej) => {
      const t = db.transaction('guides');
      const r = t.objectStore('guides').get(gid);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return guide ? { title: guide.title, steps: guide.steps.map((s) => ({ text: s.text, url: s.url, w: s.imageW, h: s.imageH })) } : { title: '(missing)', steps: [] };
  }, guideId);

  const distinctTabs = [...new Set(diag.tabs)];
  console.log('\n--- per-message gate inputs ---');
  for (const s of diag.senders) console.log('  ', s);
  console.log('\nstep messages:', diag.steps.length, '| captures:', diag.captures.length, '| errors:', diag.errors.length);
  console.log('distinct tabs that produced steps:', distinctTabs.length, distinctTabs);

  console.log('\n--- stored guide (this run) ---');
  for (const s of g.steps) console.log(`  - "${s.text}" [${s.w}x${s.h}] ${s.url.split('/').pop()}`);

  const p1 = g.steps.filter((s) => s.url.includes('page1')).length;
  const p2 = g.steps.filter((s) => s.url.includes('page2')).length;
  console.log(`\nRESULT: total=${g.steps.length} page1=${p1} page2=${p2} tabs=${distinctTabs.length}`);

  const fails = [];
  if (g.steps.length < 5) fails.push(`expected >=5 steps, got ${g.steps.length}`);
  if (p2 < 1) fails.push('no steps captured on page 2 (same-tab navigation broken)');
  if (distinctTabs.length < 2) fails.push('steps came from only one tab — new-tab capture broken (the reported bug)');
  if (g.steps.some((s) => !s.w || !s.h)) fails.push('a step is missing screenshot dimensions');
  if (diag.errors.length) fails.push(`capture errors: ${JSON.stringify(diag.errors)}`);

  if (fails.length) {
    console.log('\n❌ FAIL\n - ' + fails.join('\n - '));
    code = 1;
  } else {
    console.log('\n✅ PASS — capture continues across same-tab navigation AND new tabs');
  }
} catch (e) {
  console.error('TEST ERROR:', e);
  code = 2;
} finally {
  await ctx.close();
  server.close();
}
process.exit(code);
