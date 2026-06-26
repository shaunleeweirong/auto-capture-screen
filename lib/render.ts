// Composites a step (screenshot + blur regions + highlight + annotations)
// onto a canvas. Runs in a DOM context (editor / PDF export). The stored
// screenshot is never mutated — all overlays are data drawn at render time.

import type { Annotation, FracRect, Step } from './types';

export const ACCENT = '#4f46e5';

export interface RenderOptions {
  stepNumber?: number; // draw a numbered badge on the highlight
  scale?: number; // output scale relative to stored image size (default 1)
}

type Img = CanvasImageSource;

export function renderStep(img: Img, step: Step, opts: RenderOptions = {}): HTMLCanvasElement {
  const W = step.imageW;
  const H = step.imageH;
  const scale = opts.scale ?? 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(W * scale));
  canvas.height = Math.max(1, Math.round(H * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  ctx.drawImage(img, 0, 0, W, H);

  for (const r of step.blurRegions) drawBlur(ctx, img, r, W, H);
  if (step.highlight) drawHighlight(ctx, step.highlight, W, H, opts.stepNumber);
  for (const a of step.annotations) drawAnnotation(ctx, a, W, H);

  return canvas;
}

function toPx(r: FracRect, W: number, H: number) {
  return { x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawBlur(ctx: CanvasRenderingContext2D, img: Img, r: FracRect, W: number, H: number) {
  const { x, y, w, h } = toPx(r, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.filter = `blur(${Math.max(6, Math.round(W * 0.012))}px)`;
  ctx.drawImage(img, 0, 0, W, H);
  ctx.restore();
}

function drawHighlight(ctx: CanvasRenderingContext2D, r: FracRect, W: number, H: number, num?: number) {
  const { x, y, w, h } = toPx(r, W, H);
  const pad = Math.max(4, W * 0.004);
  const lw = Math.max(3, W * 0.0035);
  const rx = x - pad, ry = y - pad, rw = w + pad * 2, rh = h + pad * 2;

  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = lw;
  ctx.fillStyle = 'rgba(79,70,229,0.12)';
  roundRect(ctx, rx, ry, rw, rh, Math.max(6, W * 0.006));
  ctx.fill();
  ctx.stroke();

  if (num != null) {
    const radius = Math.max(12, W * 0.015);
    ctx.beginPath();
    ctx.arc(rx, ry, radius, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(radius * 1.1)}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), rx, ry + radius * 0.05);
  }
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, lw: number) {
  const head = Math.max(10, lw * 3.2);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, W: number, H: number) {
  const { x, y, w, h } = toPx(a.rect, W, H);
  const lw = Math.max(3, W * 0.0035);
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = lw;

  if (a.type === 'box') {
    ctx.strokeRect(x, y, w, h);
  } else if (a.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (a.type === 'arrow') {
    drawArrow(ctx, x, y, x + w, y + h, lw);
  } else if (a.type === 'text') {
    const fs = Math.max(14, W * 0.018);
    ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(a.text || '', x, y);
  }
  ctx.restore();
}
