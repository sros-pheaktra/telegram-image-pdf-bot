import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { TEMP_ROOT, ensureTempRoot, safeUnlink } from '../utils/cleanup.js';

export const ALLOWED_FORMATS = ['jpg','jpeg', 'png', 'webp'];
export const MAX_INPUT_BYTES = 20 * 1024 * 1024; // Telegram bots can download up to 20 MB
export const MAX_INPUT_PIXELS = 50_000_000; // ~50 megapixels
const DOWNLOAD_TIMEOUT_MS = 30_000;

export class ImageValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

/**
 * Download a file from a URL into a unique temp file for this user.
 * The URL contains the bot token, so it is never logged.
 */
export async function downloadToTemp(url, userId) {
  await ensureTempRoot();
  const filePath = path.join(TEMP_ROOT, `${userId}-${crypto.randomUUID()}.img`);

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new Error('Could not download the image from Telegram.');
  }
  if (!response.ok) {
    throw new Error('Could not download the image from Telegram.');
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_INPUT_BYTES) {
    throw new ImageValidationError('That image is too large (limit: 20 MB).');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new ImageValidationError('That image is too large (limit: 20 MB).');
  }

  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Validate with Sharp (not the file extension). Returns metadata.
 * Throws ImageValidationError for unsupported or oversized images.
 */
export async function validateImage(filePath) {
  let meta;
  try {
    meta = await sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (err) {
    if (/pixel limit/i.test(err.message)) {
      throw new ImageValidationError('That image has too many pixels (limit: ~50 megapixels).');
    }
    throw new ImageValidationError('That file is not a valid image.');
  }

  if (!ALLOWED_FORMATS.includes(meta.format)) {
    throw new ImageValidationError('Unsupported image format. Please send a JPEG, PNG or WebP image.');
  }
  if (!meta.width || !meta.height) {
    throw new ImageValidationError('Could not read the image dimensions.');
  }
  if (meta.width * meta.height > MAX_INPUT_PIXELS) {
    throw new ImageValidationError('That image has too many pixels (limit: ~50 megapixels).');
  }
  return meta;
}

/**
 * Normalize orientation, flatten transparency onto white, resize (keeping
 * aspect ratio) and compress as baseline JPEG.
 */
export async function compressToJpeg(filePath, { maxDimension, quality }) {
  const { data, info } = await sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // apply EXIF orientation
    .flatten({ background: '#ffffff' }) // white background for transparency
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toColourspace('srgb')
    .jpeg({ quality, mozjpeg: true, progressive: false })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, width: info.width, height: info.height };
}

/** Largest side of the image after EXIF orientation is applied. */
export async function getOrientedMaxSide(filePath) {
  const { info } = await sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  return Math.max(info.width, info.height);
}

export { safeUnlink };
