import type { ContentHelloMsg, ContentStepMsg, HelloResponse, PanelMsg, StartStopResponse, StepPayload } from '@/lib/messages';
import type { Guide, RecState, Step } from '@/lib/types';
import { appendStep, putGuide, putImage } from '@/lib/db';
import { getState, patchState, setState } from '@/lib/state';

const RECORDER_SCRIPT = 'content-scripts/recorder.js';
const MIN_CAPTURE_INTERVAL = 520; // Chrome throttles captureVisibleTab to 2/sec
const MAX_IMAGE_WIDTH = 1600; // downscale cap to keep storage + PDF sizes sane

// Test-only instrumentation for the e2e test, gated on the build mode so it is
// dead-code-eliminated from the production build (npm run build => MODE=production).
const TESTING = import.meta.env.MODE === 'development';
const diag = { steps: [] as string[], captures: [] as string[], errors: [] as string[] };

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel.
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.windowId != null) {
      try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      } catch (e) {
        console.error('[guidely] failed to open side panel', e);
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg: ContentStepMsg | ContentHelloMsg | PanelMsg, sender, sendResponse) => {
    if (msg?.type === 'GUIDELY_HELLO') {
      handleHello(sender).then(sendResponse);
      return true; // async response
    }
    if (msg?.type === 'GUIDELY_STEP') {
      void handleStep(msg.payload, sender);
      return false;
    }
    if (msg?.type === 'START_RECORDING') {
      startRecording()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: errMsg(e) } satisfies StartStopResponse));
      return true;
    }
    if (msg?.type === 'STOP_RECORDING') {
      stopRecording()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: errMsg(e) } satisfies StartStopResponse));
      return true;
    }
    return false;
  });

  if (TESTING) {
    // Exposed for the Playwright e2e test to start recording on a specific tab
    // without the toolbar gesture, and to read boundary diagnostics.
    Object.assign(globalThis as Record<string, unknown>, {
      __guidelyTestStart: (tabId: number, windowId: number) => startRecordingOnTab(tabId, windowId),
      __guidelyDiag: () => diag,
    });
  }
});

// ---- Recording lifecycle ----

async function handleHello(sender: chrome.runtime.MessageSender): Promise<HelloResponse> {
  const st = await getState();
  return { recording: st.recording && sender.tab?.id === st.tabId };
}

async function startRecording(): Promise<StartStopResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.windowId == null) {
    return { ok: false, error: 'No active tab to record.' };
  }
  const url = tab.url ?? '';
  if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(url) || url.startsWith('https://chromewebstore.google.com')) {
    return { ok: false, error: "Guidely can't record on this page. Open a normal website tab and try again." };
  }
  return startRecordingOnTab(tab.id, tab.windowId);
}

async function startRecordingOnTab(tabId: number, windowId: number): Promise<StartStopResponse> {
  // Best-effort: ensure the recorder is present even on tabs that were open
  // before the extension loaded. Normally-loaded pages already have it (the
  // declarative content script), and the in-page guard prevents duplicates.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [RECORDER_SCRIPT] });
  } catch {
    /* page may disallow injection; declarative injection still covers it */
  }

  const guide: Guide = {
    id: crypto.randomUUID(),
    title: `Guide — ${new Date().toLocaleDateString()}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: [],
  };
  await putGuide(guide);
  await setState({ recording: true, guideId: guide.id, tabId, windowId, count: 0 });

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'GUIDELY_RECORDING', value: true });
  } catch {
    /* content script reads recording state via GUIDELY_HELLO too */
  }

  return { ok: true, guideId: guide.id, count: 0 };
}

async function stopRecording(): Promise<StartStopResponse> {
  const st = await getState();
  if (st.tabId != null) {
    try {
      await chrome.tabs.sendMessage(st.tabId, { type: 'GUIDELY_RECORDING', value: false });
    } catch {
      /* tab may be gone */
    }
  }
  await patchState({ recording: false });
  return { ok: true, guideId: st.guideId, count: st.count };
}

// ---- Step capture (serial queue, throttle-safe) ----

const queue: Array<() => Promise<void>> = [];
let draining = false;
let lastCaptureTs = 0;

async function handleStep(payload: StepPayload, sender: chrome.runtime.MessageSender) {
  const st = await getState();
  if (!st.recording || !st.guideId) return;
  if (sender.tab?.id !== st.tabId) return; // ignore other tabs
  if (TESTING) diag.steps.push(payload.url);

  queue.push(() => captureAndStore(payload, st));
  if (!draining) void drain();
}

async function drain() {
  draining = true;
  while (queue.length) {
    const wait = Math.max(0, MIN_CAPTURE_INTERVAL - (Date.now() - lastCaptureTs));
    if (wait) await sleep(wait);
    const task = queue.shift()!;
    try {
      await task();
    } catch (e) {
      console.error('[guidely] capture failed', e);
      if (TESTING) diag.errors.push(errMsg(e));
    }
    lastCaptureTs = Date.now();
  }
  draining = false;
}

async function captureAndStore(payload: StepPayload, st: RecState) {
  if (!st.guideId || st.windowId == null) return;

  const dataUrl = await chrome.tabs.captureVisibleTab(st.windowId, { format: 'png' });
  const { blob, width, height } = await processScreenshot(dataUrl);
  const imageId = crypto.randomUUID();
  await putImage(imageId, blob);

  const step: Step = {
    id: crypto.randomUUID(),
    order: 0, // set inside appendStep
    text: payload.stepText,
    url: payload.url,
    highlight: payload.highlight,
    blurRegions: [],
    annotations: [],
    imageId,
    imageW: width,
    imageH: height,
  };
  const count = await appendStep(st.guideId, step);
  await patchState({ count });
  if (TESTING) diag.captures.push(payload.url);
}

async function processScreenshot(dataUrl: string): Promise<{ blob: Blob; width: number; height: number }> {
  const resp = await fetch(dataUrl);
  const srcBlob = await resp.blob();
  const bitmap = await createImageBitmap(srcBlob);

  const scale = bitmap.width > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH / bitmap.width : 1;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  return { blob, width, height };
}

// ---- utils ----

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
