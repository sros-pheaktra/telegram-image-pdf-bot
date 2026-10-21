import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { handleStart, handleHelp, handleCancel } from './handlers/commands.js';
import {
  handleImage,
  handleText,
  handleUnsupported,
  handleContinueChoice,
} from './handlers/image.js';
import { startSessionSweeper, stopSessionSweeper, destroyAllSessions } from './sessions/sessionManager.js';
import { purgeTempRoot } from './utils/cleanup.js';

const token = process.env.BOT_TOKEN?.trim();
if (!token) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and set your token from @BotFather.');
  process.exit(1);
}

const bot = new Telegraf(token);

// Work in private chats only, so each session belongs to exactly one person.
bot.use(async (ctx, next) => {
  if (!ctx.from || !ctx.chat) return;
  if (ctx.chat.type !== 'private') {
    if (ctx.message) await ctx.reply('Please message me in a private chat.').catch(() => {});
    return;
  }
  return next();
});

// Commands
bot.start(handleStart);
bot.help(handleHelp);
bot.command('cancel', handleCancel);

// State routing (the handlers consult the user's session state)
bot.action(/^continue:(yes|no)$/, handleContinueChoice);
bot.on('photo', handleImage);
bot.on('document', handleImage);
bot.on('text', handleText);
bot.on('message', handleUnsupported); // stickers, videos, audio, etc.

// Never leak the token: Telegraf error messages can contain request URLs.
function redact(text) {
  return String(text ?? '').split(token).join('***');
}

bot.catch(async (err, ctx) => {
  console.error('Unhandled bot error:', err?.name, redact(err?.message));
  try {
    await ctx.reply('សូមអភ័យទោស មានបញ្ហាមួយបានកើតឡើង។ សូមព្យាយាមម្តងទៀត ឬផ្ញើ /start ដើម្បីចាប់ផ្តើមឡើងវិញ។');
  } catch {
    /* ignore secondary failures */
  }
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down…`);
  stopSessionSweeper();
  try {
    bot.stop(signal);
  } catch {
    /* bot may not be running yet */
  }
  await destroyAllSessions();
  await purgeTempRoot();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', redact(reason?.message ?? reason));
});

async function main() {
  await purgeTempRoot();

  startSessionSweeper(async (chatId) => {
    if (!chatId) return;
  });

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'បង្កើត PDF' },
    { command: 'help', description: 'របៀបប្រើប្រាស់ bot' },
    { command: 'cancel', description: 'ផ្អាកដំណើរការបច្ចុប្បន្ន!' },
  ]).catch((err) => console.error('Could not set command menu:', redact(err.message)));

  await bot.launch();
}

main().catch((err) => {
  console.error('Failed to start bot:', redact(err?.message));
  process.exit(1);
});

console.log('Image-to-PDF bot starting…');
