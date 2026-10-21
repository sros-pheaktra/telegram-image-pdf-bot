import { getSession, hasSession, destroySession, clearSessionData } from '../sessions/sessionManager.js';

const START_TEXT = [
  '👋 សូមស្វាគមន៍! ខ្ញុំអាចបម្លែងរូបភាពរបស់អ្នកទៅជាឯកសារ PDF។',
  '',
  'របៀបប្រើប្រាស់៖',
  '1️⃣ ផ្ញើរូបភាពមកខ្ញុំ (JPG, JPEG, PNG ឬ WebP)',
  '2️⃣ ប្រាប់ខ្ញុំពីឈ្មោះដែលអ្នកចង់ដាក់ឱ្យឯកសារ PDF',
  '3️⃣ ខ្ញុំនឹងបង្កើតឯកសារ PDF ហើយផ្ញើត្រឡប់ទៅអ្នកវិញ',
  '',
  '📷 សូមផ្ញើរូបភាពរបស់អ្នក',
].join('\n');

const HELP_TEXT = [
  'ℹ️ របៀបប្រើប្រាស់ Bot នេះ',
  '',
  '• ផ្ញើរូបភាព (JPEG, PNG ឬ WebP) មកជារូបថត',
  '• ឆ្លើយតបដោយប្រាប់ឈ្មោះដែលអ្នកចង់ដាក់ឱ្យឯកសារ PDF។',
  '• ខ្ញុំនឹងផ្ញើឯកសារ PDF ដែលបានបង្កើតរួចទៅអ្នកវិញ។',
  '',
  'ពាក្យបញ្ជា៖',
  '/start – ចាប់ផ្តើមដំណើរការឡើងវិញ',
  '/help – បង្ហាញសារណែនាំនេះ',
  '/cancel – បោះបង់ប្រតិបត្តិការដែលកំពុងដំណើរការ',
].join('\n');


export async function handleStart(ctx) {
  const userId = ctx.from.id;
  // Start from a clean slate: drop any previous session and temp files.
  if (hasSession(userId)) await destroySession(userId);
  getSession(userId, ctx.chat.id);
  await ctx.reply(START_TEXT);
}

export async function handleHelp(ctx) {
  await ctx.reply(HELP_TEXT);
}

export async function handleCancel(ctx) {
  const userId = ctx.from.id;
  if (!hasSession(userId)) {
    await ctx.reply('មិនមានអ្វីត្រូវបោះបង់ទេ។ សូមផ្ញើរូបភាពមកខ្ញុំនៅពេលអ្នករួចរាល់! 📷');
    return;
  }
  // destroySession flags the session so any in-flight download/PDF job stops
  // quietly, and deletes temporary files.
  await destroySession(userId);
  await ctx.reply('🛑 បានបោះបង់ហើយ។ ឯកសារបណ្ដោះអាសន្នរបស់អ្នកត្រូវបានលុបចោល។\nសូមផ្ញើរូបភាព ឬប្រើ /start ដើម្បីចាប់ផ្តើមម្តងទៀត។');
}

export { clearSessionData };
