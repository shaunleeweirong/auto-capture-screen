// Shared data model for Guidely.
// All geometry is stored as fractions of the screenshot (0..1) so it is
// resolution-independent and composites cleanly at any render size.

export interface FracRect {
  x: number; // left, 0..1
  y: number; // top, 0..1
  w: number; // width, 0..1
  h: number; // height, 0..1
}

export type AnnotationType = 'arrow' | 'box' | 'ellipse' | 'text';

export interface Annotation {
  id: string;
  type: AnnotationType;
  rect: FracRect; // bounding box (for arrow: x,y = start; x+w,y+h = end)
  color: string; // CSS color
  text?: string; // for type === 'text'
}

export interface Step {
  id: string;
  order: number;
  text: string; // editable instruction, e.g. 'Click "Save"'
  url: string; // page the step happened on
  highlight: FracRect | null; // box around the clicked element
  blurRegions: FracRect[];
  annotations: Annotation[];
  imageId: string; // key into the IndexedDB image store
  imageW: number; // stored screenshot width (px)
  imageH: number; // stored screenshot height (px)
}

export interface Guide {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  steps: Step[];
  tags?: string[]; // optional, additive — no DB migration needed
}

export interface GuideSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  stepCount: number;
  tags?: string[];
}

// Recording session state, kept in chrome.storage.session.
export interface RecState {
  recording: boolean;
  guideId?: string;
  tabId?: number;
  windowId?: number;
  count: number;
  error?: string;
}
