# Guidely

> **Click-by-click guides → PDF.** A free, local-first Chrome extension that
> records a workflow as you click through it and exports a clean,
> step-by-step PDF. No accounts, no cloud, no cost.
>
> _Built by Shaun Lee Wei Rong._

Guidely is a privacy-first alternative to tools like Tango and Scribe. The two
market leaders paywall PDF export and watermark their free tiers — Guidely gives
you unwatermarked PDF export for free, with everything stored on your own device.

## Features (v1)

- **Start/Stop recording** from the side panel — no always-on capture.
- **Records the whole window** — capture follows you across same-tab navigation
  **and** new tabs opened by links, so multi-page / multi-tab workflows are
  captured continuously.
- **Screenshot per click**, with the clicked element auto-highlighted and a
  numbered badge.
- **Auto-generated step text** (e.g. `Click "Save"`) — editable.
- **Editor**: reorder, edit, and delete steps.
- **Manual blur/redaction** and **annotations** (box, circle, arrow, text).
- **PDF export** entirely in the browser — selectable captions, full-quality
  screenshots, no watermark.
- **100% local** — IndexedDB for screenshots, nothing uploaded.

## Tech stack

- [WXT](https://wxt.dev) (Vite-based Manifest V3 framework) + React + TypeScript
- `jsPDF` for client-side PDF generation
- IndexedDB (screenshots) + `chrome.storage.session` (recording state)

## Architecture

| Context | Responsibility |
|---|---|
| `entrypoints/recorder.content.ts` | Declarative content script auto-injected on every page (and re-injected after navigation). Listens for clicks, reports the element + highlight, and asks the background `GUIDELY_HELLO` on load to resume recording across navigations. |
| `entrypoints/background.ts` | Owns `captureVisibleTab`, a serial ≥520 ms capture queue (Chrome's 2/sec throttle), WebP compression via `OffscreenCanvas`, and IndexedDB writes. Recording is scoped to the **window** (gates steps by `windowId` and broadcasts start/stop to its tabs), so new tabs are captured too; capture retries once to ride out navigation/new-tab transitions. |
| `entrypoints/sidepanel/` | Start/Stop + live step count. |
| `entrypoints/editor/` | Guide list, step editor, blur/annotation tools, PDF export. |
| `lib/` | `db`, `state`, `steptext`, `render`, `pdf`, `images`, `types`, `messages`. |

Permissions: **`scripting`, `storage`, `unlimitedStorage`, `sidePanel`** plus
**`host_permissions: <all_urls>`**. The host permission is what makes capture
survive page navigation (`captureVisibleTab` works via host access, and the
content script is auto-injected on every page load). The trade-off is that the
install shows a "read your data on all websites" notice — acceptable for an
internal team tool; see Roadmap for a future just-in-time permission option.

## Develop

```bash
npm install
npm run dev        # launches Chrome with the dev build + HMR
```

Or load it manually:

```bash
npm run build      # outputs dist/chrome-mv3/
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `dist/chrome-mv3/`

## Use it

1. Open any normal website tab.
2. Click the **Guidely** toolbar icon to open the side panel (this grants the
   one-time `activeTab` access used for capture).
3. Press **Start recording** and click through your workflow.
4. Press **Stop & review** — the editor opens with your steps.
5. Edit text, reorder, blur sensitive areas, annotate, then **Export PDF**.

## Build for the Chrome Web Store

```bash
npm run zip        # outputs a store-ready .zip in dist/
```

Publishing checklist:

1. Pay the **one-time US $5** Chrome Web Store developer registration fee.
2. Create a new item and upload the zip from `dist/`.
3. Add the privacy policy (see [`PRIVACY.md`](./PRIVACY.md)) — host it at a
   public URL and link it in the dashboard. Complete the data-use disclosure
   (Guidely collects no data and uses none remotely).
4. Set **Visibility** to **Unlisted** or **Private** to share only with your
   team; switch to **Public** later if desired.
5. Submit for review (typically a few days).

## Testing

```bash
npm run test:e2e
```

Launches real Chromium with the (dev) extension loaded and drives a multi-click
workflow across a **same-tab navigation** and a **new tab opened by a link**,
asserting that steps from every page and tab are captured and stored. This guards
two regressions: only the first click being captured (v0.1.0), and recording
stopping when a link opened a new tab.

## Known limitations (v1)

- Recording follows the **window** you started in. New **separate browser
  windows / pop-ups** opened from the flow are not followed.
- A click that **opens a new tab** captures the destination page (the new tab has
  taken focus by the time the screenshot is taken), not the link itself.
- Capture is throttled to **2 screenshots/second** (a hard Chrome limit) — rapid
  clicks are queued, not dropped.
- Cannot capture `chrome://` pages, the Chrome Web Store, or cross-origin
  iframes (browser restrictions).

## Roadmap (v2 candidates)

- Team branding / logo + title page on the PDF
- HTML export and copy-to-clipboard (paste into Docs / Notion / Confluence)
- Export/import guide files for teammate handoff
- Automatic PII blur (detect password/email/card fields)
- Just-in-time host permission (request on first Start) for a cleaner install

## License

Private project. © Shaun Lee Wei Rong.
