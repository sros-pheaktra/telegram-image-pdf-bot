import { PDFDocument } from 'pdf-lib';
import { compressToJpeg, getOrientedMaxSide } from './imageProcessor.js';

export const MAX_PDF_BYTES = 2_097_152; // 2 MiB, strict limit

// Compression strategy
const START_QUALITY = 85;
const MIN_QUALITY = 40;
const QUALITY_STEP = 10;
const RETRY_QUALITY_AFTER_RESIZE = 75;
const START_MAX_DIMENSION = 3000;
const MIN_DIMENSION = 400;
const DIMENSION_SCALE = 0.8;
const MAX_ATTEMPTS = 16;
const PX_TO_POINTS = 72 / 150; // treat pixels as 150 DPI to get a sensible page size

export class PdfSizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfSizeError';
  }
}

/** Build a one-page PDF around a JPEG buffer. Page matches the image aspect ratio. */
async function buildPdf(jpegBuffer, width, height) {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedJpg(jpegBuffer);
  const pageWidth = width * PX_TO_POINTS;
  const pageHeight = height * PX_TO_POINTS;
  const page = pdf.addPage([pageWidth, pageHeight]);
  page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
  const bytes = await pdf.save({ useObjectStreams: true });
  return Buffer.from(bytes);
}

/**
 * Generate a PDF from an image file, iteratively lowering quality and
 * resolution until it fits within 2 MiB. The size of the real PDF buffer is
 * verified after every attempt. Throws PdfSizeError if it cannot fit.
 */
export async function createPdfWithinLimit(imagePath) {
  const originalMax = await getOrientedMaxSide(imagePath);
  let maxDimension = Math.min(originalMax, START_MAX_DIMENSION);
  let quality = START_QUALITY;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { buffer, width, height } = await compressToJpeg(imagePath, { maxDimension, quality });
    const pdfBuffer = await buildPdf(buffer, width, height);

    if (pdfBuffer.length <= MAX_PDF_BYTES) {
      return { buffer: pdfBuffer, size: pdfBuffer.length, attempts: attempt, width, height, quality };
    }

    // Too big: lower quality first, then shrink the image and retry.
    if (quality - QUALITY_STEP >= MIN_QUALITY) {
      quality -= QUALITY_STEP;
    } else {
      const next = Math.floor(maxDimension * DIMENSION_SCALE);
      if (next < MIN_DIMENSION) break;
      maxDimension = next;
      quality = RETRY_QUALITY_AFTER_RESIZE;
    }
  }

  throw new PdfSizeError(
    'I could not compress this image enough to produce a PDF under 2 MB.'
  );
}

/** Human-readable size, e.g. "1.43 MB". */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
