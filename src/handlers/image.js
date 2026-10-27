import { Markup } from 'telegraf';
import {
  STATES,
  getSession,
  findSession,
  setState,
  clearSessionData,
  destroySession,
  UPLOAD_DEBOUNCE_MS,
} from '../sessions/sessionManager.js';

import {
  ALLOWED_FORMATS,
  ImageValidationError,
  downloadToTemp,
  validateImage,
} from '../services/imageProcessor.js';

import {
  MAX_PDF_BYTES,
  PdfSizeError,
  createPdfWithinLimit,
  formatSize,
} from '../services/pdfGenerator.js';

import { safeUnlink } from '../utils/cleanup.js';

const ALLOWED_MIME = new Set([
  'image/jpg',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const FORMATS_TEXT = 'JPG, JPEG, PNG or WebP';
const ASK_FILENAME = 'សូមដាក់ឈ្មោះឯកសារ PDF របស់អ្នក';
const ASK_IMAGE = '📷 សូមផ្ញើរូបភាពមកខ្ញុំ';
const MAX_FILENAME_BASE = 100;

export const CONTINUE_YES = 'continue:yes';
export const CONTINUE_NO = 'continue:no';

const continueKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('✅ បង្កើតមួយទៀត', CONTINUE_YES),
  Markup.button.callback('❌ បញ្ចប់', CONTINUE_NO),
]);

/* ------------------------------------------------------------------ */
/* Filename handling                                                   */
/* ------------------------------------------------------------------ */

export function sanitizeFilename(input) {
  let name = String(input ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  name = name.replace(/\.pdf$/i, '').trim();
  name = name.replace(/^\.+|\.+$/g, '').trim();

  if (!name) return null;

  name = [...name].slice(0, MAX_FILENAME_BASE).join('').trim();

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    name = `_${name}`;
  }

  return `${name}.pdf`;
}

/* ------------------------------------------------------------------ */
/* Image source extraction                                              */
/* ------------------------------------------------------------------ */

function extractImageSource(message) {
  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];

    return {
      fileId: largest.file_id,
      size: largest.file_size,
    };
  }

  const doc = message.document;

  if (doc && ALLOWED_MIME.has((doc.mime_type || '').toLowerCase())) {
    return {
      fileId: doc.file_id,
      size: doc.file_size,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* State rejection                                                      */
/* ------------------------------------------------------------------ */

async function rejectForState(ctx, session) {
  const groupId = ctx.message?.media_group_id;

  if (groupId) {
    if (session.lastMediaGroupId === groupId) return;
    session.lastMediaGroupId = groupId;
  }

  switch (session.state) {
    case STATES.WAITING_FOR_FILENAME:
      await ctx.reply(
        `ខ្ញុំបានទទួលរូបភាពរបស់អ្នករួចហើយ។ ${ASK_FILENAME}\n` +
        '(ឬផ្ញើ /cancel ដើម្បីបញ្ឈប់។)',
      );
      break;

    case STATES.PROCESSING_PDF:
      await ctx.reply(
        '⏳ កំពុងបង្កើតឯកសារ PDF នៅឡើយ សូមរង់ចាំបន្តិច…',
      );
      break;

    case STATES.ASKING_TO_CONTINUE:
      await ctx.reply(
        'សូមជ្រើសរើសប៊ូតុងខាងលើ៖ បង្កើតឯកសារ PDF មួយទៀត ឬបញ្ចប់។',
      );
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Image collection and debounce                                        */
/* ------------------------------------------------------------------ */

function scheduleFilenamePrompt(ctx, session) {
  if (session.destroyed || session.pendingUploads > 0) return;
  if (!session.imagePaths?.length) return;

  if (session.uploadTimer) {
    clearTimeout(session.uploadTimer);
  }

  session.uploadTimer = setTimeout(async () => {
    session.uploadTimer = null;

    if (session.destroyed) return;

    // Don't ask for a filename while queued downloads are still running.
    if (session.pendingUploads > 0 || session.downloading) {
      scheduleFilenamePrompt(ctx, session);
      return;
    }

    if (session.state !== STATES.WAITING_FOR_IMAGE) return;
    if (!session.imagePaths.length) return;

    setState(session, STATES.WAITING_FOR_FILENAME);

    await ctx.reply(
      `✅ បានទទួលរូបភាព ${session.imagePaths.length} សន្លឹក។\n` +
      ASK_FILENAME,
    ).catch((err) => {
      console.error('Could not ask for filename:', err.message);
    });
  }, UPLOAD_DEBOUNCE_MS);

  session.uploadTimer.unref?.();
}

export async function handleImage(ctx) {
  const session = getSession(ctx.from.id, ctx.chat.id);
  const source = extractImageSource(ctx.message);

  if (!source) {
    return handleUnsupported(ctx);
  }

  // Allow a new upload without pressing the Continue button.
  if (session.state === STATES.ASKING_TO_CONTINUE) {
    await clearSessionData(session);
  }

  if (session.state !== STATES.WAITING_FOR_IMAGE) {
    return rejectForState(ctx, session);
  }

  // Keep a promise queue per session so simultaneous Telegram updates
  // don't get dropped while another image is downloading.
  session.imageQueue ??= Promise.resolve();
  session.pendingUploads ??= 0;
  session.pendingUploads += 1;

  const downloadTask = session.imageQueue.then(async () => {
    let filePath = null;
    session.downloading = true;

    try {
      if (session.destroyed) return;

      const link = await ctx.telegram.getFileLink(source.fileId);

      filePath = await downloadToTemp(link.href, ctx.from.id);
      await validateImage(filePath);

      // Cancellation may happen while the file is downloading.
      if (session.destroyed) {
        await safeUnlink(filePath);
        filePath = null;
        return;
      }

      // Store every validated image, preserving upload order.
      session.imagePaths.push(filePath);
      filePath = null;
    } catch (err) {
      await safeUnlink(filePath);

      if (session.destroyed) return;

      if (err instanceof ImageValidationError) {
        await ctx.reply(`⚠️ ${err.message}`).catch(() => {});
      } else if (/file is too big/i.test(err.message || '')) {
        await ctx.reply(
          'រូបភាពនេះមានទំហំធំពេក។ សូមផ្ញើរូបភាពដែលមានទំហំតិចជាង 20 MB។',
        ).catch(() => {});
      } else {
        console.error('Image handling failed:', err.name, err.message);

        await ctx.reply(
          'សូមអភ័យទោស ខ្ញុំមិនអាចដំណើរការរូបភាពនេះបានទេ។ ' +
          'សូមព្យាយាមម្តងទៀត។',
        ).catch(() => {});
      }
    } finally {
      session.downloading = false;
      session.pendingUploads = Math.max(0, session.pendingUploads - 1);

      if (!session.destroyed && session.pendingUploads === 0) {
        scheduleFilenamePrompt(ctx, session);
      }
    }
  });

  // Keep the queue usable even if an unexpected error escapes a task.
  session.imageQueue = downloadTask.catch((err) => {
    console.error('Image queue failed:', err.message);
  });

  await session.imageQueue;
}

/* ------------------------------------------------------------------ */
/* Unsupported messages                                                 */
/* ------------------------------------------------------------------ */

export async function handleUnsupported(ctx) {
  const session = getSession(ctx.from.id, ctx.chat.id);

  if (session.state !== STATES.WAITING_FOR_IMAGE) {
    return rejectForState(ctx, session);
  }

  const groupId = ctx.message?.media_group_id;

  if (groupId) {
    if (session.lastMediaGroupId === groupId) return;
    session.lastMediaGroupId = groupId;
  }

  await ctx.reply(
    `⚠️ ប្រភេទឯកសារនេះមិនត្រូវបានគាំទ្រទេ។\n` +
    `ខ្ញុំអាចទទួលយករូបភាពប្រភេទ ${FORMATS_TEXT} ប៉ុណ្ណោះ ` +
    '(ផ្ញើជារូបថត ឬជាឯកសារ)។',
  );
}

/* ------------------------------------------------------------------ */
/* Filename input                                                       */
/* ------------------------------------------------------------------ */

export async function handleText(ctx) {
  const session = getSession(ctx.from.id, ctx.chat.id);
  const text = ctx.message.text ?? '';

  switch (session.state) {
    case STATES.WAITING_FOR_IMAGE:
      await ctx.reply(ASK_IMAGE);
      return;

    case STATES.WAITING_FOR_FILENAME: {
      if (text.trim().startsWith('/')) {
        await ctx.reply(
          `${ASK_FILENAME}\n(ឬប្រើ /cancel ដើម្បីបោះបង់។)`,
        );
        return;
      }

      const filename = sanitizeFilename(text);

      if (!filename) {
        await ctx.reply(
          '⚠️ ឈ្មោះមិនអាចទទេបានទេ។ ' +
          'សូមវាយបញ្ចូលឈ្មោះសម្រាប់ឯកសារ PDF របស់អ្នក។',
        );
        return;
      }

      if (session.processing) return;

      session.filename = filename;
      await generateAndSend(ctx, session);
      return;
    }

    case STATES.PROCESSING_PDF:
      await ctx.reply(
        '⏳ កំពុងបង្កើតឯកសារ PDF នៅឡើយ សូមរង់ចាំបន្តិច…',
      );
      return;

    case STATES.ASKING_TO_CONTINUE:
      await ctx.reply(
        'សូមជ្រើសរើសប៊ូតុងខាងលើ៖ បង្កើតឯកសារ PDF មួយទៀត ឬបញ្ចប់។',
      );
      return;
  }
}

/* ------------------------------------------------------------------ */
/* PDF generation                                                       */
/* ------------------------------------------------------------------ */

async function generateAndSend(ctx, session) {
  if (session.processing || session.destroyed) return;

  if (!session.imagePaths?.length) {
    await ctx.reply(ASK_IMAGE);
    return;
  }

  if (session.pendingUploads > 0 || session.downloading) {
    await ctx.reply('⏳ សូមរង់ចាំ ខ្ញុំកំពុងទទួលរូបភាពរបស់អ្នក។');
    return;
  }

  if (session.uploadTimer) {
    clearTimeout(session.uploadTimer);
    session.uploadTimer = null;
  }

  session.processing = true;
  setState(session, STATES.PROCESSING_PDF);

  const imagePaths = [...session.imagePaths];
  const filename = session.filename;
  let statusMessage = null;

  try {
    statusMessage = await ctx.reply('⏳ កំពុងបង្កើតឯកសារ PDF…');

    // IMPORTANT: pdfGenerator.js must accept an array of paths.
    const result = await createPdfWithinLimit(imagePaths);

    if (session.destroyed) return;

    if (result.buffer.length > MAX_PDF_BYTES) {
      throw new PdfSizeError(
        'The generated PDF exceeded the 2 MB limit.',
      );
    }

    await ctx.replyWithDocument(
      { source: result.buffer, filename },
      {
        caption:
          `📄 ឈ្មោះ៖ ${filename}\n` +
          `📦 ទំហំ៖ ${formatSize(result.size)}`,
      },
    );

    if (session.destroyed) return;

    await clearSessionData(session);
    setState(session, STATES.ASKING_TO_CONTINUE);

    await ctx.reply(
      'តើអ្នកចង់បង្កើតឯកសារ PDF មួយទៀតដែរឬទេ?',
      continueKeyboard,
    );
  } catch (err) {
    if (session.destroyed) return;

    if (err instanceof PdfSizeError) {
      await ctx.reply(
        `⚠️ ${err.message}\n` +
        'សូមសាកល្បងប្រើរូបភាពដែលមានទំហំតូចជាង ឬមានភាពសាមញ្ញជាងនេះ។\n\n' +
        ASK_IMAGE,
      ).catch(() => {});
    } else {
      console.error('PDF generation failed:', err.name, err.message);

      await ctx.reply(
        'សូមអភ័យទោស មានបញ្ហាមួយបានកើតឡើងក្នុងពេលបង្កើតឯកសារ PDF របស់អ្នក។ ' +
        `សូមព្យាយាមម្តងទៀត។\n\n${ASK_IMAGE}`,
      ).catch(() => {});
    }

    await clearSessionData(session);
  } finally {
    if (!session.destroyed) {
      session.processing = false;
    }

    if (statusMessage) {
      ctx.telegram
        .deleteMessage(statusMessage.chat.id, statusMessage.message_id)
        .catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* Continue / finish buttons                                            */
/* ------------------------------------------------------------------ */

export async function handleContinueChoice(ctx) {
  const choice = ctx.callbackQuery?.data;
  const session = findSession(ctx.from.id);

  if (!session) {
    await ctx.answerCbQuery(
      'Session នេះបានបញ្ចប់ហើយ។ សូមផ្ញើ /start ដើម្បីចាប់ផ្តើមម្តងទៀត។',
    ).catch(() => {});
    return;
  }

  if (session.state !== STATES.ASKING_TO_CONTINUE) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});

  if (choice === CONTINUE_YES) {
    await clearSessionData(session);
    await ctx.reply(ASK_IMAGE);
  } else if (choice === CONTINUE_NO) {
    await destroySession(ctx.from.id);

    await ctx.reply(
      '👋 រួចរាល់ហើយ! សូមអរគុណដែលបានប្រើប្រាស់ Bot របស់យើង — ' +
      'សូមផ្ញើ /start នៅពេលដែលអ្នកត្រូវការបង្កើតឯកសារ PDF មួយទៀត។',
    );
  }
}

export { ALLOWED_FORMATS };