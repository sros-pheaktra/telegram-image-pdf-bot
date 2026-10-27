import { PDFDocument } from 'pdf-lib';
import { compressToJpeg, getOrientedMaxSide } from './imageProcessor.js';

export const MAX_PDF_BYTES = 2_097_152; // Strict 2 MiB limit

const START_QUALITY = 85;
const MIN_QUALITY = 40;
const QUALITY_STEP = 10;
const RETRY_QUALITY_AFTER_RESIZE = 75;
const START_MAX_DIMENSION = 3000;
const MIN_DIMENSION = 400;
const DIMENSION_SCALE = 0.8;
const MAX_ATTEMPTS = 16;
const PX_TO_POINTS = 72 / 150;

export class PdfSizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfSizeError';
  }
}

/** Add one JPEG image as a separate page in an existing PDF. */
async function addImagePage(pdf, jpegBuffer, width, height) {
  const image = await pdf.embedJpg(jpegBuffer);

  const pageWidth = width * PX_TO_POINTS;
  const pageHeight = height * PX_TO_POINTS;

  const page = pdf.addPage([pageWidth, pageHeight]);

  page.drawImage(image, {
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
  });
}

/** Generate a PDF containing all images at the specified compression settings. */
async function buildPdf(images, settings) {
  const pdf = await PDFDocument.create();

  for (let i = 0; i < images.length; i++) {
    const { buffer, width, height } = await compressToJpeg(
      images[i],
      settings[i],
    );

    await addImagePage(pdf, buffer, width, height);
  }

  const bytes = await pdf.save({ useObjectStreams: true });

  return Buffer.from(bytes);
}

/**
 * Accepts one image path or an array of image paths.
 * Compresses all images and combines them into one PDF under 2 MiB.
 */
export async function createPdfWithinLimit(input) {
  const imagePaths = Array.isArray(input) ? input : [input];

  if (
    imagePaths.length === 0 ||
    imagePaths.some((path) => typeof path !== 'string' || !path)
  ) {
    throw new Error('At least one valid image path is required.');
  }

  // Calculate each image's initial maximum dimension.
  const originalMaxDimensions = await Promise.all(
    imagePaths.map((path) => getOrientedMaxSide(path)),
  );

  const settings = originalMaxDimensions.map((originalMax) => ({
    maxDimension: Math.min(originalMax, START_MAX_DIMENSION),
    quality: START_QUALITY,
  }));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pdfBuffer = await buildPdf(imagePaths, settings);

    if (pdfBuffer.length <= MAX_PDF_BYTES) {
      return {
        buffer: pdfBuffer,
        size: pdfBuffer.length,
        attempts: attempt,
        pageCount: imagePaths.length,
      };
    }

    // Reduce quality on every page first.
    let qualityReduced = false;

    for (const setting of settings) {
      if (setting.quality - QUALITY_STEP >= MIN_QUALITY) {
        setting.quality -= QUALITY_STEP;
        qualityReduced = true;
      }
    }

    if (!qualityReduced) {
      // Quality is at its minimum; reduce resolution for every page.
      let dimensionReduced = false;

      for (const setting of settings) {
        const nextDimension = Math.floor(
          setting.maxDimension * DIMENSION_SCALE,
        );

        if (nextDimension >= MIN_DIMENSION) {
          setting.maxDimension = nextDimension;
          setting.quality = RETRY_QUALITY_AFTER_RESIZE;
          dimensionReduced = true;
        }
      }

      if (!dimensionReduced) break;
    }
  }

  throw new PdfSizeError(
    'I could not compress all images enough to produce a PDF under 2 MB. ' +
    'Try using fewer images or smaller images.',
  );
}

/** Human-readable size, e.g. "1.43 MB". */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
