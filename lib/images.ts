// DOM-context helper: load a stored screenshot Blob into an <img> element.
// Caller is responsible for URL.revokeObjectURL(img.src) when done.

import { getImage } from './db';

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
