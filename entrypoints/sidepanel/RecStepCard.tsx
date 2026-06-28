import { useEffect, useState } from 'react';
import type { Step } from '@/lib/types';
import { renderStepToDataURL } from '@/lib/images';

// Render the panel thumbnail smaller than the stored screenshot (≤1600px wide)
// to keep decode + toDataURL cheap and the retained data URL small.
const THUMB_TARGET_W = 720;

// A live preview card for one captured step, shown in the side panel during
// recording: number badge, editable label, delete button, and the screenshot
// with the clicked element highlighted.
export default function RecStepCard({
  step,
  index,
  deleting,
  onDelete,
  onRename,
}: {
  step: Step;
  index: number;
  deleting: boolean;
  onDelete: () => void;
  onRename: (text: string) => void;
}) {
  const [src, setSrc] = useState('');

  // Keyed on imageId only: a step's screenshot + overlays are fixed at capture
  // time, so this never re-decodes when the list refetches (new count), when
  // other steps are deleted (renumber is DOM-only), or when this step is
  // renamed (text isn't drawn). renderStepToDataURL revokes its object URL.
  useEffect(() => {
    let cancelled = false;
    const scale = Math.min(1, THUMB_TARGET_W / step.imageW);
    renderStepToDataURL(step, { scale })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(''));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.imageId]);

  return (
    <li className={`step-row${deleting ? ' deleting' : ''}`}>
      <div className="step-head">
        <span className="step-num">{index + 1}</span>
        {/* Uncontrolled + unkeyed: a refetch must not stomp what the user is
            typing, and only this input ever changes the text. */}
        <input
          className="step-text"
          aria-label={`Step ${index + 1} description`}
          defaultValue={step.text}
          onBlur={(e) => {
            const text = e.target.value;
            if (text !== step.text) onRename(text);
          }}
        />
        <div className="step-actions">
          <button
            className="icon-btn danger"
            title="Delete step"
            aria-label={`Delete step ${index + 1}`}
            onClick={onDelete}
            disabled={deleting}
          >
            ✕
          </button>
        </div>
      </div>
      <div className="step-shot">
        {src ? <img src={src} alt={`Step ${index + 1}: ${step.text}`} /> : <div className="shot-skeleton" />}
      </div>
    </li>
  );
}
