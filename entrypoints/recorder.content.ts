import type { ContentStepMsg, HelloResponse, RecordingToggleMsg, StepPayload } from '@/lib/messages';
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
    // The text field the user is currently editing. Tracked on focus and
    // flushed as a single "Type …" step when focus leaves it (or on the next
    // click), so typing becomes one step regardless of how many keystrokes.
    let pendingEdit: { el: HTMLElement; label: string; initial: string } | null = null;
    let composing = false; // don't flush mid-IME composition

    // Resume after navigation: ask the background if this tab is recording.
    chrome.runtime
      .sendMessage({ type: 'GUIDELY_HELLO' })
      .then((res?: HelloResponse) => {
        if (res?.recording) recording = true;
      })
      .catch(() => {});

    // Start/stop while the page is alive.
    chrome.runtime.onMessage.addListener((msg: RecordingToggleMsg) => {
      if (msg?.type === 'GUIDELY_RECORDING') {
        recording = msg.value;
        if (!recording) pendingEdit = null; // drop any half-tracked edit on stop
      }
    });

    function send(payload: StepPayload) {
      const msg: ContentStepMsg = { type: 'GUIDELY_STEP', payload };
      chrome.runtime.sendMessage(msg).catch(() => {});
    }

    // Emit one "Type …" step for the field being edited (if its value changed).
    function flushPendingEdit() {
      const p = pendingEdit;
      pendingEdit = null; // idempotent: a later focusout/flush becomes a no-op
      if (!p || !recording || composing) return;
      if (isSensitive(p.el)) return;
      const value = currentValue(p.el);
      if (value === p.initial) return; // focused but didn't change anything
      const rect = p.el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const stepText = generateStepText({
        tag: p.el.tagName,
        type: (p.el as HTMLInputElement).type,
        role: p.el.getAttribute('role') || undefined,
        label: p.label,
        kind: 'type',
        value,
      });
      send({ kind: 'type', stepText, label: p.label, url: location.href, highlight: rectToFrac(rect) });
    }

    // ---- typed-input lifecycle ----
    document.addEventListener(
      'focusin',
      (e) => {
        if (!recording) return;
        const ed = editableEl(e.target as Element);
        if (!ed || isSensitive(ed)) return; // sensitive fields are never tracked
        pendingEdit = { el: ed, label: labelFor(ed), initial: currentValue(ed) };
      },
      true,
    );
    document.addEventListener('compositionstart', () => { composing = true; }, true);
    document.addEventListener('compositionend', () => { composing = false; }, true);
    document.addEventListener('change', () => flushPendingEdit(), true);
    document.addEventListener('focusout', () => flushPendingEdit(), true);

    // ---- click lifecycle ----
    // Capture phase + pointerdown: fires before the page reacts or navigates,
    // and before any stopPropagation() on the target.
    document.addEventListener('pointerdown', onPointerDown, true);

    function onPointerDown(e: PointerEvent) {
      if (!recording || e.button !== 0) return;
      const raw = e.composedPath()[0] as Element | undefined;
      if (!raw || !(raw instanceof Element)) return;

      // Flush a pending text edit before recording this click, so the "Type …"
      // step is ordered before the click that follows (pointerdown fires before
      // the field's blur/change). Don't flush when the click lands inside the
      // same field still being edited.
      if (pendingEdit && !pendingEdit.el.contains(raw)) flushPendingEdit();

      if (raw === document.documentElement || raw === document.body) return;

      const el = meaningfulTarget(raw);

      // Editable text fields are represented by their "Type …" step (emitted on
      // edit), never a "Click the field" step.
      if (editableEl(el)) return;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const label = labelFor(el);
      const stepText = generateStepText({
        tag: el.tagName,
        type: (el as HTMLInputElement).type,
        role: el.getAttribute('role') || undefined,
        label,
        dropdown: isDropdownTrigger(el),
      });
      send({ stepText, label, url: location.href, highlight: rectToFrac(rect) });
    }
  },
});

const INTERACTIVE =
  'a,button,[role=button],[role=tab],[role=menuitem],[role=combobox],[role=menu],[role=listbox],[aria-haspopup],input,select,textarea,label,summary,[onclick]';

function meaningfulTarget(el: Element): Element {
  return el.closest(INTERACTIVE) ?? el;
}

// The editable text field at/above `el`, or null. Text-like inputs (including
// password — sensitivity is checked separately), textareas, and contenteditable.
function editableEl(el: Element | null): HTMLElement | null {
  if (!el) return null;
  if (el instanceof HTMLInputElement) {
    const TEXTLIKE = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', '']);
    return TEXTLIKE.has((el.type || '').toLowerCase()) ? el : null;
  }
  if (el instanceof HTMLTextAreaElement) return el;
  const host = (el as HTMLElement).closest?.('[contenteditable=""],[contenteditable="true"]') as HTMLElement | null;
  return host && host.isContentEditable ? host : null;
}

function currentValue(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return el.innerText ?? '';
}

const SENSITIVE_AC = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-type',
  'cc-given-name',
  'cc-family-name',
]);

// Fields whose contents must never be recorded — no step is produced at all.
function isSensitive(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement) {
    const t = (el.type || '').toLowerCase();
    if (t === 'password' || t === 'hidden') return true;
  }
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (ac.split(/\s+/).some((tok) => SENSITIVE_AC.has(tok))) return true; // autocomplete is space-separated
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('data-guidely-ignore')) return true; // author escape hatch
  const hint = `${(el as HTMLInputElement).name ?? ''} ${el.id}`.toLowerCase();
  if (/pass(word|wd)|\botp\b|cvv|cvc|secret|ssn|\bpin\b/.test(hint)) return true;
  return false;
}

// A custom / ARIA dropdown trigger. Native <select> is labeled by tag in steptext.
function isDropdownTrigger(el: Element): boolean {
  const hp = (el.getAttribute('aria-haspopup') || '').toLowerCase();
  if (hp === 'listbox' || hp === 'menu' || hp === 'true') return true;
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'combobox' || role === 'listbox' || role === 'menu') return true;
  return el.hasAttribute('aria-expanded');
}

function rectToFrac(rect: DOMRect): FracRect {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  return {
    x: clamp01(rect.left / vw),
    y: clamp01(rect.top / vh),
    w: clamp01(rect.width / vw),
    h: clamp01(rect.height / vh),
  };
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
