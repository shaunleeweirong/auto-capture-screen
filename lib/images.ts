// DOM-context helper: load a stored screenshot Blob into an <img> element.
// Caller is responsible for URL.revokeObjectURL(img.src) when done.

import { getImage } from './db';
import { renderStep, type RenderOptions } from './render';
import type { Step } from './types';

export async function loadImageEl(imageId: string): Promise<HTMLImageElement> {
  const blob = await getImage(imageId);
  if (!blob) throw new Error(`Image ${imageId} not found`);
  const url = URL.createObjectURL(blob);
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image'));
    };
    img.src = url;
  });
}

// Load a step's screenshot, composite its overlays (via renderStep), and return
// a data URL ready to drop into an <img src>. Centralizes the transient object
// URL's creation + revocation so callers don't leak. Returns a `data:` URI,
// which needs no revocation by the caller.
export async function renderStepToDataURL(step: Step, opts: RenderOptions = {}): Promise<string> {
  const img = await loadImageEl(step.imageId);
  try {
    return renderStep(img, step, opts).toDataURL('image/webp', 0.85);
  } finally {
    URL.revokeObjectURL(img.src);
  }
}
