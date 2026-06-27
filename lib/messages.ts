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
export type PanelMsg =
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'DELETE_STEP'; stepId: string }
  | { type: 'UPDATE_STEP'; stepId: string; text: string };

export interface StartStopResponse {
  ok: boolean;
  error?: string;
  guideId?: string;
  count?: number;
}

// Response to DELETE_STEP / UPDATE_STEP. Routed through the background so the
// mutation is serialized on the same queue as captures (no lost-update race).
export interface StepMutationResponse {
  ok: boolean;
  error?: string;
  count?: number;
}
