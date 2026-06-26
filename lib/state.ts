// Recording session state, stored in chrome.storage.session so it survives
// service-worker restarts during a session but clears when the browser closes.

import type { RecState } from './types';

const KEY = 'recState';

const DEFAULT: RecState = { recording: false, count: 0 };

export async function getState(): Promise<RecState> {
  const out = await chrome.storage.session.get(KEY);
  return { ...DEFAULT, ...(out[KEY] as RecState | undefined) };
}

export async function setState(state: RecState): Promise<void> {
  await chrome.storage.session.set({ [KEY]: state });
}

export async function patchState(patch: Partial<RecState>): Promise<RecState> {
  const next = { ...(await getState()), ...patch };
  await setState(next);
  return next;
}

// Subscribe to state changes (used by the side panel for live updates).
export function onStateChanged(cb: (state: RecState) => void): () => void {
  const listener = (
    changes: { [k: string]: chrome.storage.StorageChange },
    area: string,
  ) => {
    if (area === 'session' && changes[KEY]) {
      cb({ ...DEFAULT, ...(changes[KEY].newValue as RecState | undefined) });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
