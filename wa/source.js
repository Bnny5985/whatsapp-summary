// Read-only WhatsApp message source on top of Baileys (no browser needed).
// It only LISTENS: new messages, history synced from the phone, deletions, edits, calls, connection state.
// The application receives the socket only through readOnly() (see readonly.js).
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  BufferJSON,
} from '@whiskeysockets/baileys';
import fs from 'node:fs';
import { readOnly } from './readonly.js';
import { normalizeMessage, normalizeChat, normalizeContact, describeProtocol } from './normalize.js';

// The synced collection that holds the phone's saved contacts.
const CONTACTS_COLLECTION = 'critical_unblock_low';

// A "download ticket": just enough of a media message (key + media keys/paths) to fetch the file later, as text.
// Thumbnails are dropped (they are the bulky part and not needed to download).
const HEAVY_FIELDS = new Set(['jpegThumbnail', 'streamingSidecar']);
export function packTicket(rawMessage) {
  if (!rawMessage?.key || !rawMessage.message) return null;
  return JSON.stringify({ key: rawMessage.key, message: rawMessage.message }, (k, v) => (HEAVY_FIELDS.has(k) ? undefined : BufferJSON.replacer(k, v)));
}
export function unpackTicket(text) {
  return text ? JSON.parse(text, BufferJSON.reviver) : null;
}

// Baileys wants a pino-like logger; we keep it silent and report through our own callbacks instead.
const silentLogger = {
  level: 'silent',
  child() { return silentLogger; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

/**
 * @param {object} o
 * @param {string}   o.authDir  where the login (linked-device keys) is stored - treat like a password
 * @param {function} [o.onQr]       (qrString) show it as a QR code to scan from the phone
 * @param {function} [o.onState]    (state, info) 'connecting' | 'open' | 'reconnecting' | 'logged_out'
 * @param {function} [o.onMessage]  (message, { live }) message shaped for db.saveMessage
 * @param {function} [o.onHistory]  ({ messages, chats, progress, isLatest }) history the phone sent after linking
 * @param {function} [o.onDelete]   ({ id, chat_id })
 * @param {function} [o.onEdit]     ({ id, chat_id, content })
 * @param {function} [o.onCall]     (offer) an incoming call was seen (we never answer or reject it)
 * @param {function} [o.log]
 * @param {boolean}  [o.fetchLatestVersion] ask GitHub for the current WhatsApp Web version (off: use the bundled one)
 */
export function createSource(o) {
  const noop = () => {};
  const { onQr = noop, onState = noop, onMessage = noop, onHistory = noop, onContacts = noop, onDelete = noop, onEdit = noop, onCall = noop, log = noop } = o;
  let raw = null;
  let stopped = false;
  let guarded = null;
  let auth = null;

  async function connect() {
    onState('connecting');
    const { state, saveCreds } = await useMultiFileAuthState(o.authDir);
    auth = state;
    let version;
    if (o.fetchLatestVersion) {
      try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { log(`version lookup failed: ${e.message}`); }
    }

    raw = makeWASocket({
      ...(version ? { version } : {}), // an explicit `version: undefined` would override the library's default
      auth: state,
      logger: o.logger || silentLogger,
      // WhatsApp's servers currently drop "Desktop" clients that ask for full history (428 before the QR,
      // verified Nov 2026; see Baileys issue #2880). Chrome/Ubuntu is accepted and works with pairing codes.
      browser: o.browser || Browsers.ubuntu('Chrome'),
      syncFullHistory: o.syncFullHistory ?? true,
      markOnlineOnConnect: false,           // do not look "online" - the phone keeps its own notifications
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    guarded = readOnly(raw);

    raw.ev.on('creds.update', saveCreds);

    raw.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) onQr(qr);
      if (connection === 'open') onState('open');
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) return onState('logged_out', { code });
        if (stopped) return;
        onState('reconnecting', { code, reason: lastDisconnect?.error?.message });
        // restartRequired (515) is normal right after linking; anything else gets a short pause.
        const wait = code === DisconnectReason.restartRequired ? 500 : 3000;
        setTimeout(() => { if (!stopped) connect().catch((e) => log(`reconnect failed: ${e.message}`)); }, wait);
      }
    });

    raw.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        const proto = describeProtocol(m);
        if (proto) {
          if (proto.kind === 'delete') onDelete(proto);
          else if (proto.kind === 'edit') onEdit(proto);
          continue;
        }
        const msg = normalizeMessage(m);
        if (msg) onMessage(msg, { live: type === 'notify', raw: m });
      }
    });

    raw.ev.on('contacts.upsert', (list) => onContacts(list.map(normalizeContact).filter(Boolean)));
    raw.ev.on('contacts.update', (list) => onContacts(list.map(normalizeContact).filter(Boolean)));

    raw.ev.on('messaging-history.set', ({ messages = [], chats = [], contacts = [], progress, isLatest }) => {
      onHistory({
        messages: messages.map(normalizeMessage).filter(Boolean),
        chats: chats.map(normalizeChat).filter(Boolean),
        contacts: contacts.map(normalizeContact).filter(Boolean),
        progress: progress ?? null,
        isLatest: !!isLatest,
      });
    });

    raw.ev.on('call', (calls) => { for (const c of calls) onCall({ id: c.id, from: c.from, status: c.status, isVideo: !!c.isVideo, isGroup: !!c.isGroup }); });
  }

  /**
   * Ask WhatsApp again for the address book (the names as the user saved them on the phone).
   * WhatsApp normally sends it once, while linking, and afterwards only the changes; this re-reads the whole list.
   * It is a read: we forget our local copy's version, so the server sends the full list, which arrives as onContacts.
   */
  async function refreshContacts() {
    if (!raw || !auth) throw new Error('WhatsApp is not connected');
    await auth.keys.set({ 'app-state-sync-version': { [CONTACTS_COLLECTION]: null } });
    await raw.resyncAppState([CONTACTS_COLLECTION], true);
  }

  /**
   * Forget this computer's WhatsApp login and start again unlinked (used after the phone removed the link, or to link
   * another number). Only local files are deleted; nothing is sent to WhatsApp.
   */
  async function relink() {
    stopped = true;
    try { raw?.end(undefined); } catch { /* already closed */ }
    fs.rmSync(o.authDir, { recursive: true, force: true });
    stopped = false;
    return connect();
  }

  return {
    relink,
    start: () => { stopped = false; return connect(); },
    stop: () => { stopped = true; try { raw?.end(undefined); } catch { /* already closed */ } },
    /**
     * Downloads and decrypts the file of a message we received (a read: it only fetches from WhatsApp's CDN).
     * No "ask the phone to re-upload" fallback: an expired file simply fails.
     */
    downloadMedia: (rawMessage) =>
      downloadMediaMessage(rawMessage, 'buffer', {}, { logger: silentLogger, reuploadRequest: async (m) => m }),
    refreshContacts,
    /** The read-only view of the socket (null until start() has run). */
    get socket() { return guarded; },
  };
}
