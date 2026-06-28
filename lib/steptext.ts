// Deterministic, template-based step-text generation (no AI, no backend).
// Pure function — safe to run in the content script (page context).

export interface StepTextInput {
  tag: string;
  type?: string;
  role?: string;
  label: string;
  kind?: 'click' | 'type'; // 'type' → a typed-input step
  value?: string; // the typed text (for kind === 'type')
  dropdown?: boolean; // a custom/ARIA dropdown trigger
}

export function generateStepText({ tag, type, role, label, kind, value, dropdown }: StepTextInput): string {
  const name = (label || 'element').trim().replace(/\s+/g, ' ').slice(0, 80) || 'element';
  const t = tag.toLowerCase();
  const ty = (type || '').toLowerCase();

  if (kind === 'type') {
    const v = (value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return v ? `Type "${v}" in "${name}"` : `Fill in the "${name}" field`;
  }

  if (role === 'tab') return `Open the "${name}" tab`;
  if (role === 'menuitem' || role === 'menuitemcheckbox') return `Select "${name}"`;
  if (dropdown) return `Open the "${name}" dropdown`;

  if (t === 'input') {
    if (['button', 'submit', 'reset', 'image'].includes(ty)) return `Click "${name}"`;
    if (ty === 'checkbox' || ty === 'radio') return `Select "${name}"`;
    if (ty === 'file') return `Upload a file for "${name}"`;
    return `Click the "${name}" field`;
  }
  if (t === 'textarea') return `Click the "${name}" field`;
  if (t === 'select') return `Open the "${name}" dropdown`;
  if (t === 'a') return `Click "${name}"`;
  if (t === 'button') return `Click "${name}"`;

  return `Click "${name}"`;
}
