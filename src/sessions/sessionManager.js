import { safeUnlinkAll } from '../utils/cleanup.js';

export const STATES = Object.freeze({
  WAITING_FOR_IMAGE: 'WAITING_FOR_IMAGE',
  WAITING_FOR_FILENAME: 'WAITING_FOR_FILENAME',
  PROCESSING_PDF: 'PROCESSING_PDF',
  ASKING_TO_CONTINUE: 'ASKING_TO_CONTINUE',
});

const SESSION_TTL_MS = 15 * 60 * 1000; // abandoned sessions expire after 15 minutes
const SWEEP_INTERVAL_MS = 60 * 1000;

/** @type {Map<number, object>} one independent session per Telegram user id */
const sessions = new Map();

let sweeper = null;
let onExpire = null;

function createSession(userId, chatId) {
  return {
    userId,
    chatId,
    state: STATES.WAITING_FOR_IMAGE,
    imagePath: null,
    filename: null,
    processing: false, // guards against duplicate PDF creation
    downloading: false, // guards against concurrent image downloads
    destroyed: false, // set when cancelled/expired so in-flight work can bail out
    lastMediaGroupId: null,
    lastActivity: Date.now(),
  };
}

/** Look up a session without creating one. */
export function findSession(userId) {
  return sessions.get(userId) || null;
}

/** Get (or lazily create) the session for a user. */
export function getSession(userId, chatId) {
  let session = sessions.get(userId);
  if (!session) {
    session = createSession(userId, chatId);
    sessions.set(userId, session);
  }
  if (chatId) session.chatId = chatId;
  session.lastActivity = Date.now();
  return session;
}

export function hasSession(userId) {
  return sessions.has(userId);
}

export function setState(session, state) {
  session.state = state;
  session.lastActivity = Date.now();
}

/** Delete temp files and reset the per-conversation data, keeping the session object. */
export async function clearSessionData(session) {
  const files = [session.imagePath];
  session.imagePath = null;
  session.filename = null;
  session.processing = false;
  session.downloading = false;
  session.lastMediaGroupId = null;
  session.state = STATES.WAITING_FOR_IMAGE;
  session.lastActivity = Date.now();
  await safeUnlinkAll(files);
}

/** Fully destroy a user's session (temp files + state). */
export async function destroySession(userId) {
  const session = sessions.get(userId);
  if (!session) return;
  sessions.delete(userId);
  session.destroyed = true;
  const files = [session.imagePath];
  session.imagePath = null;
  session.filename = null;
  await safeUnlinkAll(files);
}

/** Start the background sweep that expires abandoned sessions. */
export function startSessionSweeper(expireCallback) {
  onExpire = expireCallback;
  if (sweeper) return;
  sweeper = setInterval(async () => {
    const now = Date.now();
    for (const [userId, session] of sessions) {
      if (session.processing) continue; // never expire mid-generation
      if (now - session.lastActivity < SESSION_TTL_MS) continue;
      const chatId = session.chatId;
      await destroySession(userId);
      if (onExpire) {
        try {
          await onExpire(chatId);
        } catch (err) {
          console.error('Could not send expiration notice:', err.message);
        }
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

export function stopSessionSweeper() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

/** Destroy every session (used on shutdown). */
export async function destroyAllSessions() {
  await Promise.all([...sessions.keys()].map(destroySession));
}
