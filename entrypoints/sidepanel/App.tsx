import { useEffect, useState } from 'react';
import type { PanelMsg, StartStopResponse } from '@/lib/messages';
import type { RecState } from '@/lib/types';
import { getState, onStateChanged } from '@/lib/state';

function openEditor(guideId?: string) {
  const url = chrome.runtime.getURL('editor.html') + (guideId ? `?id=${guideId}` : '');
  void chrome.tabs.create({ url });
}

export default function App() {
  const [state, setState] = useState<RecState>({ recording: false, count: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getState().then(setState);
    return onStateChanged(setState);
  }, []);

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

  const { recording, count } = state;

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
        <section className="card recording">
          <div className="rec-dot" />
          <div className="rec-count">{count}</div>
          <div className="rec-label">step{count === 1 ? '' : 's'} captured</div>
          <p className="hint">Click through your workflow — each click becomes a step.</p>
          <button className="btn btn-stop" onClick={stop} disabled={busy}>
            Stop &amp; review
          </button>
        </section>
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
