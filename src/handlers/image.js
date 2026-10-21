import { Markup } from 'telegraf';
import {
  STATES,
  getSession,
  findSession,
  setState,
  clearSessionData,
  destroySession,
} from '../sessions/sessionManager.js';
import {
  ALLOWED_FORMATS,
  MAX_INPUT_BYTES,
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

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const FORMATS_TEXT = 'JPG, JPEG, PNG or WebP';
const ASK_FILENAME = 'សូមដាក់ឈ្មោះ file PDF របស់អ្នក?';
const ASK_IMAGE = '📷 សូមផ្ញើរូបភាពមកខ្ញុំ ';
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

/**
 * Remove invalid filename characters and append ".pdf".
 * Returns null if nothing usable remains (empty / whitespace only).
 */
export function sanitizeFilename(input) {
  let name = String(input ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  name = name.replace(/\.pdf$/i, '').trim(); // normalise the extension
  name = name.replace(/^\.+|\.+$/g, '').trim(); // no leading/trailing dots
  if (!name) return null;

  name = [...name].slice(0, MAX_FILENAME_BASE).join('').trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
  return `${name}.pdf`;
}

/* ------------------------------------------------------------------ */
/* Step 1: image upload                                                */
/* ------------------------------------------------------------------ */

/** Returns { fileId, size } for an acceptable message, or null. */
function extractImageSource(message) {
  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, size: largest.file_size };
  }
  const doc = message.document;
  if (doc && ALLOWED_MIME.has((doc.mime_type || '').toLowerCase())) {
    return { fileId: doc.file_id, size: doc.file_size };
  }
  return null;
}

/** Answer messages that are not usable in the current state (once per media group). */
async function rejectForState(ctx, session) {
  const groupId = ctx.message?.media_group_id;
  if (groupId) {
    if (session.lastMediaGroupId === groupId) return;
    session.lastMediaGroupId = groupId;
  }
  switch (session.state) {
    case STATES.WAITING_FOR_FILENAME:
      await ctx.reply(`ខ្ញុំបានទទួលរូបភាពរបស់អ្នករួចហើយ។ ${ASK_FILENAME}\n(ឬផ្ញើ /cancel ដើម្បីបញ្ឈប់។)`);
      break;

    case STATES.PROCESSING_PDF:
      await ctx.reply('⏳ កំពុងបង្កើតឯកសារ PDF នៅឡើយ សូមរង់ចាំបន្តិច…');
      break;

    case STATES.ASKING_TO_CONTINUE:
      await ctx.reply('សូមជ្រើសរើសប៊ូតុងខាងលើ៖ បង្កើតឯកសារ PDF មួយទៀត ឬបញ្ចប់។');
      break;

    default:
      break;
  }
}

/** Photo or image-document upload. */

export async function handleImage(ctx) {
  const session = getSession(ctx.from.id, ctx.chat.id);
  const source = extractImageSource(ctx.message);

  // Allow a new image without pressing Continue.
  if (
    session.state === STATES.ASKING_TO_CONTINUE &&
    source
  ) {
    await clearSessionData(session);
  }

  if (session.state !== STATES.WAITING_FOR_IMAGE) {
    return rejectForState(ctx, session);
  }

  if (session.downloading) return;

  if (!source) {
    return handleUnsupported(ctx);
  }

  session.downloading = true;
  let filePath = null;
  try {
    const link = await ctx.telegram.getFileLink(source.fileId);
    filePath = await downloadToTemp(link.href, ctx.from.id);
    await validateImage(filePath);

    // The user may have cancelled while we were downloading.
    if (session.destroyed) {
      await safeUnlink(filePath);
      return;
    }

    session.imagePath = filePath;
    filePath = null; // ownership moved to the session
    setState(session, STATES.WAITING_FOR_FILENAME);
    await ctx.reply(`${ASK_FILENAME}`);
  } catch (err) {
    await safeUnlink(filePath);
    if (session.destroyed) return;
    if (err instanceof ImageValidationError) {
      await ctx.reply(`⚠️ ${err.message}`);
    } else if (/file is too big/i.test(err.message || '')) {
      await ctx.reply('រូបភាពនេះមានទំហំធំពេក។ សូមផ្ញើរូបភាពដែលមានទំហំតិចជាង 20 MB។');
    } else {
      console.error('Image handling failed:', err.name, err.message);
      await ctx.reply('សូមអភ័យទោស ខ្ញុំមិនអាចដំណើរការរូបភាពនេះបានទេ។ សូមព្យាយាមម្តងទៀត។');
    }
  } finally {
    session.downloading = false;
  }
}

/** Any message that is not an image we can use (wrong file type, stickers, video, ...). */
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
    `⚠️ ប្រភេទឯកសារនេះមិនត្រូវបានគាំទ្រទេ។\nខ្ញុំអាចទទួលយករូបភាពប្រភេទ ${FORMATS_TEXT} ប៉ុណ្ណោះ (ផ្ញើជារូបថត ឬជាឯកសារ)។`
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: filename (plain text)                                       */
/* ------------------------------------------------------------------ */


export async function handleText(ctx) {
  const session = getSession(ctx.from.id, ctx.chat.id);
  const text = ctx.message.text ?? '';

  switch (session.state) {
    case STATES.WAITING_FOR_IMAGE:
      await ctx.reply(ASK_IMAGE);
      return;

    case STATES.WAITING_FOR_FILENAME: {
      // កុំឱ្យពាក្យបញ្ជា /command ដែលមិនស្គាល់ ក្លាយជាឈ្មោះឯកសារ។
      if (text.trim().startsWith('/')) {
        await ctx.reply(`${ASK_FILENAME}\n(ឬប្រើ /cancel ដើម្បីបោះបង់។)`);
        return;
      }

      const filename = sanitizeFilename(text);
      if (!filename) {
        await ctx.reply('⚠️ ឈ្មោះមិនអាចទទេបានទេ។ សូមវាយបញ្ចូលឈ្មោះសម្រាប់ឯកសារ PDF របស់អ្នក។');
        return;
      }

      if (session.processing) return; // ការពារការបង្កើត PDF ស្ទួន

      session.filename = filename;
      await generateAndSend(ctx, session);
      return;
    }

    case STATES.PROCESSING_PDF:
      await ctx.reply('⏳ កំពុងបង្កើតឯកសារ PDF នៅឡើយ សូមរង់ចាំបន្តិច…');
      return;

    case STATES.ASKING_TO_CONTINUE:
      await ctx.reply('សូមជ្រើសរើសប៊ូតុងខាងលើ៖ បង្កើតឯកសារ PDF មួយទៀត ឬបញ្ចប់។');
      return;

    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Step 3: create and send the PDF                                     */
/* ------------------------------------------------------------------ */

async function generateAndSend(ctx, session) {
  
  if (session.processing) return;
  session.processing = true;
  setState(session, STATES.PROCESSING_PDF);

  const { imagePath, filename } = session;
  let statusMessage = null;

  try {
    statusMessage = await ctx.reply('⏳ កំពុងបង្កើតឯកសារ PDF…');
    const result = await createPdfWithinLimit(imagePath);

    if (session.destroyed) return; // cancelled / expired while working

    // Final, independent guard: never send anything over 2 MiB.
    if (result.buffer.length > MAX_PDF_BYTES) {
      throw new PdfSizeError('The generated PDF exceeded the 2 MB limit.');
    }

    
    await ctx.replyWithDocument(
      { source: result.buffer, filename },
      {
        caption: `📄 ឈ្មោះ៖ ${filename}\n📦 ទំហំ​៖ ${formatSize(result.size)}`
      }
    );

    if (session.destroyed) return;

    // Remove the old temporary image.
    await safeUnlink(imagePath);
    session.imagePath = null;

    // Keep the session ready for either Continue or a new image.
    setState(session, STATES.ASKING_TO_CONTINUE);

    await ctx.reply(
      'តើអ្នកចង់បង្កើតឯកសារ PDF មួយទៀតដែរឬទេ?',
      continueKeyboard
    );

  } catch (err) {
    if (session.destroyed) return;
    if (err instanceof PdfSizeError) {
      await ctx.reply(
        `⚠️ ${err.message}\nសូមសាកល្បងប្រើរូបភាពដែលមានទំហំតូចជាង ឬមានភាពសាមញ្ញជាងនេះ។\n\n${ASK_IMAGE}`
      ).catch(() => {});
    } else {
      console.error('PDF generation failed:', err.name, err.message);
      await ctx.reply(
       `សូមអភ័យទោស មានបញ្ហាមួយបានកើតឡើងក្នុងពេលបង្កើតឯកសារ PDF របស់អ្នក។ សូមព្យាយាមម្តងទៀត។\n\n${ASK_IMAGE}`
      ).catch(() => {});
    }
    await clearSessionData(session); // deletes the temp image, resets to WAITING_FOR_IMAGE
  } finally {
    if (!session.destroyed) session.processing = false;
    if (statusMessage) {
      ctx.telegram.deleteMessage(statusMessage.chat.id, statusMessage.message_id).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* Step 4: "create another?" buttons                                   */
/* ------------------------------------------------------------------ */

export async function handleContinueChoice(ctx) {
  const choice = ctx.callbackQuery?.data;
  const session = findSession(ctx.from.id);

  if (!session) {
    await ctx.answerCbQuery('Session នេះបានបញ្ចប់ហើយ។ សូមផ្ញើ /start ដើម្បីចាប់ផ្តើមម្តងទៀត។').catch(() => {});
    return;
  }
  // Ignore clicks in any other state (including repeated clicks during PDF generation).
  if (session.state !== STATES.ASKING_TO_CONTINUE) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
  // Remove the buttons so they cannot be clicked twice.
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});

  if (choice === CONTINUE_YES) {
    // State flips synchronously inside clearSessionData, so a double click is ignored above.
    await clearSessionData(session);
    await ctx.reply(`${ASK_IMAGE}`);
  } else if (choice === CONTINUE_NO) {
    await destroySession(ctx.from.id);
    await ctx.reply('👋 រួចរាល់ហើយ! សូមអរគុណដែលបានប្រើប្រាស់ Bot របស់យើង — សូមផ្ញើ /start នៅពេលដែលអ្នកត្រូវការបង្កើតឯកសារ PDF មួយទៀត។');
  }
}

export { ALLOWED_FORMATS };
