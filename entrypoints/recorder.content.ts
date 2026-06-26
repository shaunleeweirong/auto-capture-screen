import type { ContentStepMsg, HelloResponse, RecordingToggleMsg } from '@/lib/messages';
import type { FracRect } from '@/lib/types';
import { generateStepText } from '@/lib/steptext';

// Declarative content script on every page. It is auto-injected on each page
// load (including after navigation), and asks the background whether this tab
// is mid-recording so it can resume. Capture itself happens in the background
// via host_permissions, so it survives navigation.
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    const w = window as unknown as { __guidelyInstalled?: boolean };
    if (w.__guidelyInstalled) return; // guard against double-injection
    w.__guidelyInstalled = true;

    let recording = false;

    // Resume after navigation: ask the background if this tab is recording.
    chrome.runtime
      .sendMessage({ type: 'GUIDELY_HELLO' })
      .then((res?: HelloResponse) => {
        if (res?.recording) recording = true;
      })
      .catch(() => {});

    // Start/stop while the page is alive.
    chrome.runtime.onMessage.addListener((msg: RecordingToggleMsg) => {
      if (msg?.type === 'GUIDELY_RECORDING') recording = msg.value;
    });

    // Capture phase + pointerdown: fires before the page reacts or navigates,
    // and before any stopPropagation() on the target.
    document.addEventListener('pointerdown', onPointerDown, true);

    function onPointerDown(e: PointerEvent) {
      if (!recording || e.button !== 0) return;
      const raw = e.composedPath()[0] as Element | undefined;
      if (!raw || !(raw instanceof Element)) return;
      if (raw === document.documentElement || raw === document.body) return;

      const el = meaningfulTarget(raw);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const highlight: FracRect = {
        x: clamp01(rect.left / vw),
        y: clamp01(rect.top / vh),
        w: clamp01(rect.width / vw),
        h: clamp01(rect.height / vh),
      };

      const label = labelFor(el);
      const stepText = generateStepText({
        tag: el.tagName,
        type: (el as HTMLInputElement).type,
        role: el.getAttribute('role') || undefined,
        label,
      });

      const msg: ContentStepMsg = {
        type: 'GUIDELY_STEP',
        payload: { stepText, label, url: location.href, highlight },
      };
      chrome.runtime.sendMessage(msg).catch(() => {});
    }
  },
});

const INTERACTIVE =
  'a,button,[role=button],[role=tab],[role=menuitem],input,select,textarea,label,summary,[onclick]';

function meaningfulTarget(el: Element): Element {
  return el.closest(INTERACTIVE) ?? el;
}

function labelFor(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();

  if (el instanceof HTMLInputElement) {
    if (['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value;
    if (el.placeholder) return el.placeholder;
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab?.textContent?.trim()) return lab.textContent.trim();
    }
    if (el.name) return el.name;
  }

  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim();

  const text = (el as HTMLElement).innerText?.trim();
  if (text) return text;

  const alt = el.getAttribute('alt');
  if (alt?.trim()) return alt.trim();

  const innerImg = el.querySelector?.('img[alt]')?.getAttribute('alt');
  if (innerImg?.trim()) return innerImg.trim();

  return el.tagName.toLowerCase();
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
