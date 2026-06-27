import type {
  ContentHelloMsg,
  ContentStepMsg,
  HelloResponse,
  PanelMsg,
  StartStopResponse,
  StepMutationResponse,
  StepPayload,
} from '@/lib/messages';
import type { Guide, RecState, Step } from '@/lib/types';
import { appendStep, deleteImage, deleteStep, putGuide, putImage, updateStepText } from '@/lib/db';
import { getState, patchState, setState } from '@/lib/state';

const RECORDER_SCRIPT = 'content-scripts/recorder.js';
const MIN_CAPTURE_INTERVAL = 520; // Chrome throttles captureVisibleTab to 2/sec
const MAX_IMAGE_WIDTH = 1600; // downscale cap to keep storage + PDF sizes sane

// Test-only instrumentation for the e2e test, gated on the build mode so it is
// dead-code-eliminated from the production build (npm run build => MODE=production).
const TESTING = import.meta.env.MODE === 'development';
const diag = {
  steps: [] as string[],
  tabs: [] as number[],
  senders: [] as string[],
  captures: [] as string[],
  errors: [] as string[],
};

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
    if (msg?.type === 'DELETE_STEP') {
      handleDeleteStep(msg.stepId)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: errMsg(e) } satisfies StepMutationResponse));
      return true;
    }
    if (msg?.type === 'UPDATE_STEP') {
      handleUpdateStep(msg.stepId, msg.text)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: errMsg(e) } satisfies StepMutationResponse));
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
      // Delete a step the same way the side panel does — enqueued on the serial
      // capture queue — so the e2e test can exercise delete-during-recording.
      __guidelyTestDelete: (stepId: string) => handleDeleteStep(stepId),
    });
  }
});

// ---- Recording lifecycle ----

async function handleHello(sender: chrome.runtime.MessageSender): Promise<HelloResponse> {
  const st = await getState();
  return { recording: st.recording && sender.tab?.windowId === st.windowId };
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

  // Enable recording on every tab already open in this window. New tabs opened
  // later (e.g. by links) resume automatically via GUIDELY_HELLO on load.
  await broadcastRecording(windowId, true);

  return { ok: true, guideId: guide.id, count: 0 };
}

async function stopRecording(): Promise<StartStopResponse> {
  const st = await getState();
  if (st.windowId != null) {
    await broadcastRecording(st.windowId, false);
  }
  await patchState({ recording: false });
  return { ok: true, guideId: st.guideId, count: st.count };
}

// Tell every tab in a window to start/stop recording. Tabs without the content
// script (chrome://, etc.) simply reject the message — ignored.
async function broadcastRecording(windowId: number, value: boolean) {
  const tabs = await chrome.tabs.query({ windowId });
  await Promise.all(
    tabs.map((t) =>
      t.id != null
        ? chrome.tabs.sendMessage(t.id, { type: 'GUIDELY_RECORDING', value }).catch(() => {})
        : Promise.resolve(),
    ),
  );
}

// ---- Step capture & mutation (single serial queue, throttle-safe) ----

// Captures AND mutations (delete / rename) share one serial queue so a delete
// can never interleave with an in-flight capture's read-modify-write of the
// guide. Only captures are subject to the 2/sec captureVisibleTab throttle;
// mutations run promptly and don't perturb capture timing.
type QueueTask = { kind: 'capture' | 'mutate'; run: () => Promise<void> };

const queue: QueueTask[] = [];
let draining = false;
let lastCaptureTs = 0;

async function handleStep(payload: StepPayload, sender: chrome.runtime.MessageSender) {
  const st = await getState();
  if (TESTING) {
    diag.senders.push(`tab=${sender.tab?.id} win=${sender.tab?.windowId} stWin=${st.windowId} rec=${st.recording}`);
  }
  if (!st.recording || !st.guideId) return;
  if (sender.tab?.windowId !== st.windowId) return; // record the whole window
  if (TESTING) {
    diag.steps.push(payload.url);
    if (sender.tab?.id != null) diag.tabs.push(sender.tab.id);
  }

  queue.push({ kind: 'capture', run: () => captureAndStore(payload, st) });
  if (!draining) void drain();
}

async function drain() {
  draining = true;
  while (queue.length) {
    const task = queue.shift()!;
    if (task.kind === 'capture') {
      const wait = Math.max(0, MIN_CAPTURE_INTERVAL - (Date.now() - lastCaptureTs));
      if (wait) await sleep(wait);
    }
    try {
      await task.run();
    } catch (e) {
      console.error('[guidely] queue task failed', e);
      if (TESTING) diag.errors.push(errMsg(e));
    }
    if (task.kind === 'capture') lastCaptureTs = Date.now();
  }
  draining = false;
}

// Enqueue a guide mutation on the serial queue. Resolves when the task actually
// runs (after any queued captures ahead of it), so the panel's await is a true
// completion signal.
function enqueueMutation(run: () => Promise<StepMutationResponse>): Promise<StepMutationResponse> {
  return new Promise((resolve) => {
    queue.push({
      kind: 'mutate',
      run: async () => {
        try {
          resolve(await run());
        } catch (e) {
          resolve({ ok: false, error: errMsg(e) });
        }
      },
    });
    if (!draining) void drain();
  });
}

async function handleDeleteStep(stepId: string): Promise<StepMutationResponse> {
  const st = await getState();
  if (!st.recording || !st.guideId) return { ok: false, error: 'Not recording.' };
  const guideId = st.guideId;
  return enqueueMutation(async () => {
    const { count, removedImageId } = await deleteStep(guideId, stepId);
    if (removedImageId) await deleteImage(removedImageId).catch(() => {});
    await patchState({ count }); // drives the panel's live-list refetch
    return { ok: true, count };
  });
}

async function handleUpdateStep(stepId: string, text: string): Promise<StepMutationResponse> {
  const st = await getState();
  if (!st.recording || !st.guideId) return { ok: false, error: 'Not recording.' };
  const guideId = st.guideId;
  // No patchState: count is unchanged, and the panel already shows the new text
  // (uncontrolled input + optimistic local state); the editor/PDF read from DB.
  return enqueueMutation(async () => {
    const count = await updateStepText(guideId, stepId, text);
    return { ok: true, count };
  });
}

async function captureAndStore(payload: StepPayload, st: RecState) {
  if (!st.guideId || st.windowId == null) return;

  // A click that opens a new tab (or navigates) can momentarily leave the
  // window on a not-yet-committed page, where captureVisibleTab throws a
  // host-access error. Retry once after a short delay so the new page commits.
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(st.windowId, { format: 'png' });
  } catch {
    await sleep(400);
    dataUrl = await chrome.tabs.captureVisibleTab(st.windowId, { format: 'png' });
  }
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
