import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, AnnotationType, FracRect, Guide, GuideSummary, Step } from '@/lib/types';
import { deleteGuide, deleteImage, getGuide, listGuideSummaries, putGuide } from '@/lib/db';
import { loadImageEl } from '@/lib/images';
import { renderStep } from '@/lib/render';
import { exportGuideToPdf } from '@/lib/pdf';

export default function App() {
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get('id'));

  return (
    <div className="editor">
      {selectedId ? (
        <GuideView guideId={selectedId} onBack={() => setSelectedId(null)} />
      ) : (
        <GuideList onOpen={setSelectedId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function GuideList({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<GuideSummary[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GuideSummary | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    void listGuideSummaries().then(setItems);
  }, []);
  useEffect(refresh, [refresh]);

  // Soft delete with a 5s undo window: drop it from the list immediately but
  // defer the (irreversible) DB delete so the user can take it back.
  function requestRemove(g: GuideSummary) {
    if (deleteTimer.current) {
      clearTimeout(deleteTimer.current); // commit any already-pending delete first
      if (pendingDelete) void deleteGuide(pendingDelete.id);
    }
    setItems((prev) => prev?.filter((x) => x.id !== g.id) ?? prev);
    setPendingDelete(g);
    deleteTimer.current = setTimeout(() => {
      void deleteGuide(g.id);
      deleteTimer.current = null;
      setPendingDelete(null);
    }, 5000);
  }
  function undoRemove() {
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    deleteTimer.current = null;
    setPendingDelete(null);
    refresh();
  }

  async function openRecorder() {
    try {
      const win = await chrome.windows.getCurrent();
      if (win.id != null) await chrome.sidePanel.open({ windowId: win.id });
    } catch (e) {
      console.error('[guidely] could not open the side panel', e);
    }
  }

  return (
    <div className="container">
      <header className="topbar">
        <div className="brand-row">
          <div className="logo">
            <img src="/icon/128.png" alt="Guidely" />
          </div>
          <div>
            <h1>Guidely</h1>
            <p className="tagline">Your guides — by Shaun Lee Wei Rong</p>
          </div>
        </div>
      </header>

      {items === null ? (
        <div className="loading-row" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Loading your guides…</span>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <h2>No guides yet</h2>
          <p>
            Open the Guidely side panel on any website, press <strong>Start recording</strong>, and click through a
            workflow. Your guide will appear here.
          </p>
          <button className="btn btn-primary" onClick={openRecorder}>
            Open the recorder
          </button>
        </div>
      ) : (
        <ul className="guide-grid">
          {items.map((g) => (
            <li key={g.id} className="guide-card">
              <button className="guide-open" onClick={() => onOpen(g.id)} aria-label={`Open guide: ${g.title}`}>
                <h3>{g.title}</h3>
                <p className="meta">
                  {g.stepCount} step{g.stepCount === 1 ? '' : 's'} · {new Date(g.updatedAt).toLocaleDateString()}
                </p>
              </button>
              <button
                className="icon-btn danger"
                title="Delete guide"
                aria-label={`Delete guide: ${g.title}`}
                onClick={() => requestRemove(g)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete && (
        <div className="toast" role="status" aria-live="polite">
          <span>Deleted “{pendingDelete.title}”</span>
          <button onClick={undoRemove}>Undo</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function GuideView({ guideId, onBack }: { guideId: string; onBack: () => void }) {
  const [guide, setGuide] = useState<Guide | null | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    void getGuide(guideId).then((g) => setGuide(g ?? null));
  }, [guideId]);

  // Optimistically apply the edit, then await the write. If the write fails we
  // revert to `prev` and surface it — edits (including privacy blur regions)
  // must never silently disappear on the next reload. Returns whether it saved.
  const persist = useCallback(async (next: Guide, prev: Guide): Promise<boolean> => {
    next.updatedAt = Date.now();
    setGuide(next);
    try {
      await putGuide(next);
      setSaveError(null);
      return true;
    } catch {
      setGuide(prev);
      setSaveError("Couldn't save your change — it was undone. Check available storage and try again.");
      return false;
    }
  }, []);

  function setTitle(title: string) {
    if (!guide) return;
    void persist({ ...guide, title }, guide);
  }

  function updateStep(stepId: string, patch: Partial<Step>) {
    if (!guide) return;
    void persist({ ...guide, steps: guide.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) }, guide);
  }

  function moveStep(index: number, dir: -1 | 1) {
    if (!guide) return;
    const target = index + dir;
    if (target < 0 || target >= guide.steps.length) return;
    const steps = guide.steps.slice();
    [steps[index], steps[target]] = [steps[target], steps[index]];
    void persist({ ...guide, steps }, guide);
  }

  async function removeStep(step: Step) {
    if (!guide) return;
    // Only drop the image blob once the guide write that removed the step has
    // actually committed, so a failed save can't orphan a still-referenced image.
    const ok = await persist({ ...guide, steps: guide.steps.filter((s) => s.id !== step.id) }, guide);
    if (ok) await deleteImage(step.imageId).catch(() => {});
  }

  async function exportPdf() {
    if (!guide) return;
    setExporting(true);
    try {
      await exportGuideToPdf(guide, { loadImage: loadImageEl });
    } catch (e) {
      alert(`PDF export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  async function removeGuide() {
    if (!guide) return;
    // Two-step inline confirm instead of a jarring native dialog: first click
    // arms it, second click deletes. Blur (below) disarms it.
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    await deleteGuide(guide.id);
    onBack();
  }

  if (guide === undefined) {
    return (
      <div className="container">
        <div className="loading-row" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Loading…</span>
        </div>
      </div>
    );
  }
  if (guide === null) {
    return (
      <div className="container">
        <p className="muted">This guide could not be found.</p>
        <button className="btn btn-ghost" onClick={onBack}>
          ← Back to guides
        </button>
      </div>
    );
  }

  return (
    <div className="container">
      <header className="topbar sticky">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Guides
        </button>
        <div className="spacer" />
        <button className="btn btn-ghost danger" onClick={removeGuide} onBlur={() => setConfirmingDelete(false)}>
          {confirmingDelete ? 'Confirm delete?' : 'Delete'}
        </button>
        <button
          className="btn btn-primary"
          onClick={exportPdf}
          disabled={exporting || guide.steps.length === 0}
          aria-busy={exporting}
        >
          {exporting ? 'Creating PDF…' : 'Download PDF'}
        </button>
      </header>

      <input
        className="title-input"
        defaultValue={guide.title}
        onBlur={(e) => setTitle(e.target.value.trim() || 'Untitled guide')}
        placeholder="Guide title"
      />
      <p className="meta">
        {guide.steps.length} step{guide.steps.length === 1 ? '' : 's'} · Created{' '}
        {new Date(guide.createdAt).toLocaleString()}
      </p>

      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}

      {guide.steps.length === 0 ? (
        <div className="empty">
          <p>This guide has no steps.</p>
        </div>
      ) : (
        <ol className="step-list">
          {guide.steps.map((step, i) => (
            <StepRow
              key={step.id}
              step={step}
              index={i}
              total={guide.steps.length}
              onPatch={(patch) => updateStep(step.id, patch)}
              onMove={(dir) => moveStep(i, dir)}
              onDelete={() => removeStep(step)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function StepRow({
  step,
  index,
  total,
  onPatch,
  onMove,
  onDelete,
}: {
  step: Step;
  index: number;
  total: number;
  onPatch: (patch: Partial<Step>) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [src, setSrc] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (editing) return; // annotator renders its own raw view
    let cancelled = false;
    loadImageEl(step.imageId)
      .then((img) => {
        if (cancelled) {
          URL.revokeObjectURL(img.src);
          return;
        }
        const canvas = renderStep(img, step, { stepNumber: index + 1 });
        setSrc(canvas.toDataURL('image/webp', 0.9));
        URL.revokeObjectURL(img.src);
      })
      .catch(() => setSrc(''));
    return () => {
      cancelled = true;
    };
  }, [step.imageId, step.highlight, step.blurRegions, step.annotations, index, editing]);

  return (
    <li className="step-row">
      <div className="step-head">
        <span className="step-num">{index + 1}</span>
        <input
          className="step-text"
          aria-label={`Step ${index + 1} description`}
          defaultValue={step.text}
          key={step.text}
          onBlur={(e) => onPatch({ text: e.target.value })}
        />
        <div className="step-actions">
          <button
            className={`icon-btn ${editing ? 'active' : ''}`}
            title="Edit screenshot — blur & annotate"
            aria-label={`Edit screenshot for step ${index + 1}: blur and annotate`}
            aria-pressed={editing}
            onClick={() => setEditing((v) => !v)}
          >
            ✎
          </button>
          <button className="icon-btn" title="Move up" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button
            className="icon-btn"
            title="Move down"
            aria-label={`Move step ${index + 1} down`}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button className="icon-btn danger" title="Delete step" aria-label={`Delete step ${index + 1}`} onClick={onDelete}>
            ✕
          </button>
        </div>
      </div>

      {editing ? (
        <StepAnnotator step={step} onPatch={onPatch} onDone={() => setEditing(false)} />
      ) : (
        <div className="step-shot">{src ? <img src={src} alt={`Step ${index + 1}: ${step.text}`} /> : <div className="shot-skeleton" />}</div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

type Tool = 'blur' | 'box' | 'arrow' | 'ellipse' | 'text';
const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827'];
const MIN_DRAG = 0.012;

function StepAnnotator({ step, onPatch, onDone }: { step: Step; onPatch: (patch: Partial<Step>) => void; onDone: () => void }) {
  const [src, setSrc] = useState('');
  const [tool, setTool] = useState<Tool>('box');
  const [color, setColor] = useState(COLORS[0]);
  const [draft, setDraft] = useState<FracRect | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let url = '';
    let cancelled = false;
    loadImageEl(step.imageId)
      .then((img) => {
        if (cancelled) {
          URL.revokeObjectURL(img.src);
          return;
        }
        url = img.src;
        setSrc(img.src);
      })
      .catch(() => setSrc(''));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [step.imageId]);

  function toFrac(e: React.PointerEvent): { x: number; y: number } {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  function onDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const p = toFrac(e);
    startRef.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    if (!startRef.current) return;
    setDraft(rectFrom(startRef.current, toFrac(e), tool));
  }
  function onUp() {
    const s = startRef.current;
    const d = draft;
    startRef.current = null;
    setDraft(null);
    if (!s || !d) return;
    commit(d);
  }

  function commit(rect: FracRect) {
    const tiny = Math.abs(rect.w) < MIN_DRAG && Math.abs(rect.h) < MIN_DRAG;
    if (tool === 'blur') {
      if (tiny) return;
      onPatch({ blurRegions: [...step.blurRegions, normalize(rect)] });
      return;
    }
    if (tool === 'text') {
      const text = prompt('Annotation text:')?.trim();
      if (!text) return;
      onPatch({ annotations: [...step.annotations, { id: crypto.randomUUID(), type: 'text', rect: { ...rect, w: 0, h: 0 }, color, text }] });
      return;
    }
    if (tiny) return;
    const type: AnnotationType = tool;
    const stored = type === 'arrow' ? rect : normalize(rect);
    const ann: Annotation = { id: crypto.randomUUID(), type, rect: stored, color };
    onPatch({ annotations: [...step.annotations, ann] });
  }

  function removeBlur(i: number) {
    onPatch({ blurRegions: step.blurRegions.filter((_, j) => j !== i) });
  }
  function removeAnn(id: string) {
    onPatch({ annotations: step.annotations.filter((a) => a.id !== id) });
  }

  return (
    <div className="annotator">
      <div className="anno-toolbar">
        {(['box', 'ellipse', 'arrow', 'text', 'blur'] as Tool[]).map((t) => (
          <button
            key={t}
            className={`tool-btn ${tool === t ? 'active' : ''}`}
            aria-pressed={tool === t}
            onClick={() => setTool(t)}
          >
            {toolLabel(t)}
          </button>
        ))}
        <span className="tool-sep" />
        {COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${color === c ? 'active' : ''} ${tool === 'blur' ? 'disabled' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
            title={c}
            aria-label={`Annotation color ${c}`}
            aria-pressed={color === c}
          />
        ))}
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={onDone}>
          Done
        </button>
      </div>

      <div
        className="anno-stage"
        ref={stageRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        {src ? <img className="anno-img" src={src} alt="Step screenshot" draggable={false} /> : <div className="shot-skeleton" />}

        {/* existing blur regions */}
        {step.blurRegions.map((r, i) => (
          <div key={`b${i}`} className="ov ov-blur" style={boxStyle(r)}>
            <span className="ov-tag">blur</span>
            <button
              className="ov-del"
              aria-label="Remove blur region"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => removeBlur(i)}
            >
              ✕
            </button>
          </div>
        ))}

        {/* existing annotations */}
        {step.annotations.map((a) => (
          <AnnotationOverlay key={a.id} a={a} onDelete={() => removeAnn(a.id)} />
        ))}

        {/* in-progress draft */}
        {draft && <DraftShape rect={draft} tool={tool} color={color} />}
      </div>

      <p className="anno-hint">Drag on the screenshot to add a {toolLabel(tool).toLowerCase()}. Click ✕ on a shape to remove it.</p>
    </div>
  );
}

function AnnotationOverlay({ a, onDelete }: { a: Annotation; onDelete: () => void }) {
  if (a.type === 'arrow') {
    return (
      <>
        <svg className="anno-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
          <line
            x1={a.rect.x}
            y1={a.rect.y}
            x2={a.rect.x + a.rect.w}
            y2={a.rect.y + a.rect.h}
            stroke={a.color}
            strokeWidth={3}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
          />
        </svg>
        <button
          className="ov-del floating"
          aria-label="Remove annotation"
          style={{ left: `${(a.rect.x + a.rect.w) * 100}%`, top: `${(a.rect.y + a.rect.h) * 100}%` }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDelete}
        >
          ✕
        </button>
      </>
    );
  }
  if (a.type === 'text') {
    return (
      <div className="ov ov-text" style={{ left: `${a.rect.x * 100}%`, top: `${a.rect.y * 100}%`, color: a.color }}>
        {a.text}
        <button className="ov-del" aria-label="Remove annotation" onPointerDown={(e) => e.stopPropagation()} onClick={onDelete}>
          ✕
        </button>
      </div>
    );
  }
  return (
    <div className={`ov ${a.type === 'ellipse' ? 'ov-ellipse' : 'ov-box'}`} style={{ ...boxStyle(a.rect), borderColor: a.color }}>
      <button className="ov-del" onPointerDown={(e) => e.stopPropagation()} onClick={onDelete}>
        ✕
      </button>
    </div>
  );
}

function DraftShape({ rect, tool, color }: { rect: FracRect; tool: Tool; color: string }) {
  if (tool === 'arrow') {
    return (
      <svg className="anno-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
        <line
          x1={rect.x}
          y1={rect.y}
          x2={rect.x + rect.w}
          y2={rect.y + rect.h}
          stroke={color}
          strokeWidth={3}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  const n = normalize(rect);
  const cls = tool === 'blur' ? 'ov-blur' : tool === 'ellipse' ? 'ov-ellipse' : 'ov-box';
  return <div className={`ov draft ${cls}`} style={{ ...boxStyle(n), borderColor: color }} />;
}

// ---- geometry helpers ----

function rectFrom(s: { x: number; y: number }, p: { x: number; y: number }, tool: Tool): FracRect {
  if (tool === 'arrow' || tool === 'text') return { x: s.x, y: s.y, w: p.x - s.x, h: p.y - s.y };
  return { x: s.x, y: s.y, w: p.x - s.x, h: p.y - s.y };
}
function normalize(r: FracRect): FracRect {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}
function boxStyle(r: FracRect): React.CSSProperties {
  const n = normalize(r);
  return { left: `${n.x * 100}%`, top: `${n.y * 100}%`, width: `${n.w * 100}%`, height: `${n.h * 100}%` };
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function toolLabel(t: Tool): string {
  return { box: 'Box', ellipse: 'Circle', arrow: 'Arrow', text: 'Text', blur: 'Blur' }[t];
}
