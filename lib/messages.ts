// Message contracts between content script, service worker, and side panel.

import type { FracRect } from './types';

export interface StepPayload {
  stepText: string;
  label: string;
  url: string;
  highlight: FracRect | null;
}

// content script -> service worker
export interface ContentStepMsg {
  type: 'GUIDELY_STEP';
  payload: StepPayload;
}

// content script -> service worker, asked on every page load so a freshly
// navigated page can resume recording.
export interface ContentHelloMsg {
  type: 'GUIDELY_HELLO';
}

export interface HelloResponse {
  recording: boolean;
}

// service worker -> content script
export interface RecordingToggleMsg {
  type: 'GUIDELY_RECORDING';
  value: boolean;
}

// side panel -> service worker
export type PanelMsg = { type: 'START_RECORDING' } | { type: 'STOP_RECORDING' };

export interface StartStopResponse {
  ok: boolean;
  error?: string;
  guideId?: string;
  count?: number;
}
