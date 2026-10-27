import { safeUnlinkAll } from '../utils/cleanup.js';

export const STATES = Object.freeze({
  WAITING_FOR_IMAGE: 'WAITING_FOR_IMAGE',
  WAITING_FOR_FILENAME: 'WAITING_FOR_FILENAME',
  PROCESSING_PDF: 'PROCESSING_PDF',
  ASKING_TO_CONTINUE: 'ASKING_TO_CONTINUE',
});

const SESSION_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

/** Wait this long after the latest image before asking for a filename. */
export const UPLOAD_DEBOUNCE_MS = 2000;

/** @type {Map<number, object>} One independent session per Telegram user ID. */
const sessions = new Map();

let sweeper = null;
let onExpire = null;

function createSession(userId, chatId) {
  return {
    userId,
    chatId,
    state: STATES.WAITING_FOR_IMAGE,
    imagePaths: [],
    imageQueue: Promise.resolve(),
    pendingUploads: 0,
    uploadTimer: null,
    filename: null,
    processing: false,
    downloading: false,
    destroyed: false,
    lastMediaGroupId: null,
    lastActivity: Date.now(),
  };
}

function cancelUploadTimer(session) {
  if (session.uploadTimer) {
    clearTimeout(session.uploadTimer);
    session.uploadTimer = null;
  }
}

/** Look up a session without creating one. */
export function findSession(userId) {
  return sessions.get(userId) || null;
}

/** Get or create a session for a user. */
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

/** Cancel the upload timer and remove temporary files. */
export async function clearSessionData(session) {
  cancelUploadTimer(session);

  const files = [
    ...(session.imagePaths || []),
    session.imagePath,
  ].filter(Boolean);

  session.imagePaths = [];
  session.imagePath = null;
  session.pendingUploads = 0;
  session.imageQueue = Promise.resolve();
  session.filename = null;
  session.processing = false;
  session.downloading = false;
  session.lastMediaGroupId = null;
  session.state = STATES.WAITING_FOR_IMAGE;
  session.lastActivity = Date.now();

  await safeUnlinkAll([...new Set(files)]);
}

/** Fully destroy a user's session. */
export async function destroySession(userId) {
  const session = sessions.get(userId);
  if (!session) return;

  // Remove the session first so new updates cannot reuse it.
  sessions.delete(userId);
  session.destroyed = true;

  cancelUploadTimer(session);

  const files = [
    ...(session.imagePaths || []),
    session.imagePath,
  ].filter(Boolean);

  session.imagePaths = [];
  session.imagePath = null;
  session.filename = null;
  session.lastMediaGroupId = null;

  await safeUnlinkAll([...new Set(files)]);
}

/** Start the background sweep for abandoned sessions. */
export function startSessionSweeper(expireCallback) {
  onExpire = expireCallback;

  if (sweeper) return;

  sweeper = setInterval(async () => {
    const now = Date.now();

    for (const [userId, session] of sessions) {
      if (session.processing || session.downloading) continue;
      if (now - session.lastActivity < SESSION_TTL_MS) continue;

      const chatId = session.chatId;

      await destroySession(userId);

      if (onExpire) {
        try {
          await onExpire(chatId);
        } catch (err) {
          console.error(
            'Could not send expiration notice:',
            err.message,
          );
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

/** Destroy every active session, for example during shutdown. */
export async function destroyAllSessions() {
  await Promise.all([...sessions.keys()].map(destroySession));
}