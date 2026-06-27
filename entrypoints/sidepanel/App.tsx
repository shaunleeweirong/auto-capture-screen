import { useEffect, useRef, useState } from 'react';
import type { PanelMsg, StartStopResponse } from '@/lib/messages';
import type { RecState, Step } from '@/lib/types';
import { getState, onStateChanged } from '@/lib/state';
import { getGuide } from '@/lib/db';
import RecStepCard from './RecStepCard';

function openEditor(guideId?: string) {
  const url = chrome.runtime.getURL('editor.html') + (guideId ? `?id=${guideId}` : '');
  void chrome.tabs.create({ url });
}

export default function App() {
  const [state, setState] = useState<RecState>({ recording: false, count: 0 });
  const [steps, setSteps] = useState<Step[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);

  useEffect(() => {
    void getState().then(setState);
    return onStateChanged(setState);
  }, []);

  const { recording, count, guideId } = state;

  // Live step list: the panel re-renders whenever `count` changes, so re-fetch
  // the guide then. By the time count advances, the background has already
  // written the guide (appendStep / deleteStep run before patchState). The
  // `cancelled` guard discards a stale fetch if count advances again mid-fetch.
  useEffect(() => {
    if (!recording || !guideId) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    void getGuide(guideId).then((g) => {
      if (!cancelled) setSteps(g?.steps ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [recording, guideId, count]);

  // Auto-scroll to the newest card when the list grows (never on delete).
  useEffect(() => {
    if (steps.length > prevLen.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLen.current = steps.length;
  }, [steps]);

  async function start() {
    setBusy(true);
    setError(null);
    const res = (await chrome.runtime.sendMessage({ type: 'START_RECORDING' } satisfies PanelMsg)) as StartStopResponse;
    setBusy(false);
    if (!res?.ok) setError(res?.error ?? 'Could not start recording.');
  }

  async function stop() {
    setBusy(true);
    const res = (await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' } satisfies PanelMsg)) as StartStopResponse;
    setBusy(false);
    if (res?.ok && res.guideId && (res.count ?? 0) > 0) openEditor(res.guideId);
  }

  async function handleDelete(stepId: string) {
    setDeletingIds((prev) => new Set(prev).add(stepId));
    try {
      // The background deletes on its serial queue and patches `count`, which
      // refetches the guide and drops this row.
      await chrome.runtime.sendMessage({ type: 'DELETE_STEP', stepId } satisfies PanelMsg);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(stepId);
        return next;
      });
    }
  }

  function handleRename(stepId: string, text: string) {
    // Optimistic: reflect the label locally so a concurrent refetch (from a
    // later capture) can't momentarily show stale text; the background persists.
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, text } : s)));
    void chrome.runtime.sendMessage({ type: 'UPDATE_STEP', stepId, text } satisfies PanelMsg);
  }

  return (
    <div className="panel">
      <header className="brand">
        <div className="logo">G</div>
        <div>
          <h1>Guidely</h1>
          <p className="tagline">Click-by-click guides → PDF</p>
        </div>
      </header>

      {recording ? (
        <>
          <section className="card recording">
            <div className="rec-dot" />
            <div className="rec-count">{count}</div>
            <div className="rec-label">step{count === 1 ? '' : 's'} captured</div>
            <button className="btn btn-stop" onClick={stop} disabled={busy}>
              Stop &amp; review
            </button>
          </section>

          {steps.length === 0 ? (
            <p className="hint">Click through your workflow — each click becomes a step.</p>
          ) : (
            <div className="rec-steps" ref={scrollRef}>
              <ol className="step-list">
                {steps.map((step, i) => (
                  <RecStepCard
                    key={step.id}
                    step={step}
                    index={i}
                    deleting={deletingIds.has(step.id)}
                    onDelete={() => handleDelete(step.id)}
                    onRename={(text) => handleRename(step.id, text)}
                  />
                ))}
              </ol>
            </div>
          )}
        </>
      ) : (
        <section className="card">
          <p className="lead">
            Record a workflow into a step-by-step guide, then export it as a PDF — all on your device, nothing uploaded.
          </p>
          <button className="btn btn-primary" onClick={start} disabled={busy}>
            ● Start recording
          </button>
          {state.error && !error && <p className="error">{state.error}</p>}
        </section>
      )}

      {error && <p className="error">{error}</p>}

      <footer className="foot">
        <button className="link" onClick={() => openEditor()}>
          Open my guides →
        </button>
      </footer>
    </div>
  );
}
