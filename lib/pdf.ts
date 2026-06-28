// Client-side PDF export with jsPDF: a title block followed by one
// (step text + composited screenshot) per step, with manual pagination.
// No html2canvas — captions stay selectable, screenshots stay full quality.

import { jsPDF } from 'jspdf';
import type { Guide } from './types';
import { renderStep } from './render';

export interface PdfDeps {
  // Resolve a stored image id to a loaded <img> element.
  loadImage: (imageId: string) => Promise<HTMLImageElement>;
}

export async function exportGuideToPdf(guide: Guide, deps: PdfDeps): Promise<void> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;
  let y = margin;

  // ---- Title block ----
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(17, 24, 39);
  const titleLines = doc.splitTextToSize(guide.title || 'Untitled guide', contentW);
  doc.text(titleLines, margin, y + 16);
  y += 16 + titleLines.length * 24;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120, 120, 130);
  const created = new Date(guide.createdAt).toLocaleDateString();
  doc.text(
    `${guide.steps.length} step${guide.steps.length === 1 ? '' : 's'}  ·  ${created}  ·  Built with Guidely by Shaun Lee Wei Rong`,
    margin,
    y,
  );
  y += 24;

  // ---- Steps ----
  for (let i = 0; i < guide.steps.length; i++) {
    const step = guide.steps[i];

    // Load + composite the screenshot. If one image is missing or corrupt, keep
    // the step caption (noting the screenshot is gone) instead of failing the
    // entire export — one bad blob shouldn't make the whole guide un-exportable.
    let dataUrl: string | null = null;
    let aspect = 0; // height / width
    try {
      const img = await deps.loadImage(step.imageId);
      const canvas = renderStep(img, step, { stepNumber: i + 1 });
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      aspect = canvas.height / canvas.width;
    } catch (e) {
      console.error('[guidely] step image unavailable, exporting caption only', e);
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(17, 24, 39);
    const caption = dataUrl ? `${i + 1}.  ${step.text}` : `${i + 1}.  ${step.text}  (screenshot unavailable)`;
    const lines = doc.splitTextToSize(caption, contentW);
    const textH = lines.length * 15 + 6;

    // Height left for the image after the caption — never negative, so a long
    // caption can't drive doc.addImage into negative dimensions.
    const maxImgH = Math.max(0, pageH - margin * 2 - textH);
    let imgW = contentW;
    let imgH = dataUrl ? aspect * imgW : 0;
    if (imgH > maxImgH) {
      imgH = maxImgH;
      imgW = imgH / aspect; // aspect > 0 whenever imgH > 0
    }

    const blockH = textH + imgH + 18;
    if (y + blockH > pageH - margin) {
      doc.addPage();
      y = margin;
    }

    doc.text(lines, margin, y + 11);
    y += textH;
    if (dataUrl && imgH > 0) {
      doc.addImage(dataUrl, 'JPEG', margin, y, imgW, imgH);
      doc.setDrawColor(226, 232, 240);
      doc.rect(margin, y, imgW, imgH);
      y += imgH + 18;
    } else {
      y += 18;
    }
  }

  const safe = (guide.title || 'guidely-guide').replace(/[^\w\- ]+/g, '').trim() || 'guidely-guide';
  doc.save(`${safe}.pdf`);
}
