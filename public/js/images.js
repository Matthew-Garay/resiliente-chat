/**
 * Imágenes: se recomprimen en el navegador antes de cifrarlas.
 * Volver a dibujarlas en un canvas elimina los metadatos (EXIF, GPS, modelo de cámara).
 */

export const MAX_IMAGE_BYTES = 200_000;
const MAX_SIDE = 1600;

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo comprimir'))), 'image/jpeg', quality);
  });
}

/** Devuelve los bytes de un JPEG de como máximo MAX_IMAGE_BYTES, sin metadatos. */
export async function compressImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    let side = MAX_SIDE;
    let quality = 0.82;
    for (let attempt = 0; attempt < 12; attempt++) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // fondo para imágenes con transparencia
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToJpeg(canvas, quality);
      if (blob.size <= MAX_IMAGE_BYTES) return new Uint8Array(await blob.arrayBuffer());
      if (quality > 0.5) quality -= 0.12;
      else side = Math.round(side * 0.75);
    }
  } finally {
    bitmap.close();
  }
  throw new Error('La imagen es demasiado grande incluso comprimida');
}

/** Solo se muestran JPEG válidos (empiezan por FF D8 FF). */
export function isJpeg(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
