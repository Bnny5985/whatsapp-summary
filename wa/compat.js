// Lets the existing engine (index.js) run on Baileys without rewriting its logic.
// It presents the small part of the old open-wa "client" API that the engine uses, and turns Baileys events into
// open-wa-shaped messages. Everything is READ-ONLY: sendText and friends throw ReadOnlyViolation.
//
// Not provided on purpose:
//  - sending of any kind;
//  - on-demand old history (getAllMessagesInChat / loadEarlierMessages return []): WhatsApp sends history once,
//    while linking, which the linking flow stores itself (see ingest.js).
import fs from 'node:fs';
import { createSource, packTicket, unpackTicket } from './source.js';
import { rowToMessage } from './archive.js';
import { ReadOnlyViolation } from './readonly.js';

const STATE = { connecting: 'OPENING', open: 'CONNECTED', reconnecting: 'TIMEOUT', logged_out: 'UNPAIRED' };

/** Baileys-normalised message -> the object shape the engine reads (see handleIncomingMessage in index.js). */
// `bookLoaded`: we hold the phone's address book. Only then can we say "this number is NOT saved" (the engine listens to
// unsaved numbers automatically); without it a missing name just means "we do not know".
export function toEngineMessage(m, { names = new Map(), raw, bookLoaded = false } = {}) {
  const savedFlag = (c) => (c?.saved ? { isMyContact: true } : bookLoaded ? { isMyContact: false } : {});
  const contact = names.get(m.chat_id);
  const senderContact = names.get(m.sender_id);
  const isMedia = m.has_media && m.type !== 'sticker';
  const chatName = contact?.name || null;
  return {
    id: m.id,
    chatId: m.chat_id,
    from: m.chat_id,
    fromMe: !!m.from_me,
    author: m.is_group ? m.sender_id : undefined,
    sender: {
      id: m.sender_id,
      pushname: m.sender_name || senderContact?.name || undefined,
      formattedName: senderContact?.name || m.sender_name || undefined,
      ...savedFlag(senderContact),
    },
    timestamp: m.timestamp,
    isGroupMsg: !!m.is_group,
    chat: { name: chatName, formattedTitle: chatName, ...(contact || bookLoaded ? { contact: { name: contact?.name || null, ...savedFlag(contact) } } : {}) },
    type: m.type,
    body: m.type === 'chat' ? m.content : undefined,
    caption: m.type === 'chat' ? undefined : m.content || undefined,
    mimetype: isMedia ? m.mimetype || undefined : undefined,
    _raw: raw, // kept so the file can be downloaded later (decryptMedia)
  };
}

/**
 * @param {object} o
 * @param {string}   o.authDir
 * @param {function} [o.onQr]       called when this computer is not linked yet (pairing is needed)
 * @param {function} [o.onHistory]  history delivered while linking: ({ messages, chats, contacts, isLatest })
 * @param {function} [o.log]
 * @param {object}   [o.source]     replace the real Baileys source (tests)
 * @param {object}   [o.archive]    rolling archive (archive.js) for chats that are not marked
 * @param {function} [o.isMarked]   async (chat_id) => true when the user marked that chat (kept for good in the work DB)
 * @param {function} [o.keepImages] async (chat_id) => true when the user turned on "keep images in the archive" for that chat
 * @param {Array}    [o.knownContacts] names learned in earlier runs: [{ id, name, saved }] (WhatsApp sends the address book only once)
 * @param {function} [o.onContacts] called with the names that are new or changed: [{ id, name, saved }] - store them
 */
export function createCompat({ authDir, onQr, onHistory, log = () => {}, source: injected, createSourceFn = createSource, archive = null, isMarked = null, keepImages = null, knownContacts = [], onContacts = null }) {
  const listeners = { message: [], state: [], call: [] };
  const names = new Map(); // jid -> { name, saved }   saved = the name the user gave this contact on the phone
  let bookLoaded = false;
  for (const k of knownContacts) if (k?.id && k.name) { names.set(k.id, { name: k.name, saved: !!k.saved }); if (k.saved) bookLoaded = true; }
  let state = 'OPENING';
  let needsLink = false;   // WhatsApp asked us to link (no valid login on this computer)
  let loggedOut = false;   // the phone removed this computer from its linked devices
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const emit = (kind, ...args) => {
    for (const fn of listeners[kind]) {
      Promise.resolve().then(() => fn(...args)).catch((e) => log(`listener error: ${e.message}`));
    }
  };
  const setState = (s) => {
    if (s === state) return;
    state = s;
    emit('state', s);
    if (s === 'CONNECTED') readyResolve(client);
  };
  const remember = (list = []) => {
    const changed = [];
    for (const c of list) {
      for (const id of [c.id, c.alt]) {
        if (!id || !c.name) continue;
        const old = names.get(id);
        if (old?.saved && !c.saved) continue; // a name the user saved beats the name the person chose
        if (old && old.name === c.name && !!old.saved === !!c.saved) continue;
        names.set(id, { name: c.name, saved: !!c.saved });
        if (c.saved) bookLoaded = true;
        changed.push({ id, name: c.name, saved: !!c.saved });
      }
    }
    if (changed.length && onContacts) Promise.resolve().then(() => onContacts(changed)).catch((e) => log(`saving contacts failed: ${e.message}`));
  };

  // Without an archive every chat counts as marked (the engine alone decides what to keep, as before).
  // If the check fails we also say "marked": better not to archive than to archive a chat the user cares about.
  const marked = async (chat_id) => {
    if (!archive || !isMarked) return true;
    try { return !!(await isMarked(chat_id)); } catch { return true; }
  };
  const imageExt = (mime) => (/png/.test(mime || '') ? 'png' : /webp/.test(mime || '') ? 'webp' : 'jpg');
  const archiveLive = (m, raw) => {
    if (!archive) return;
    marked(m.chat_id)
      .then(async (yes) => {
        if (yes) return;
        const stored = await archive.save(m, m.has_media ? packTicket(raw) : null);
        // Per-chat option: also keep the picture itself (a read from WhatsApp's servers), for as long as the message lives here.
        if (stored && m.type === 'image' && raw && keepImages && (await keepImages(m.chat_id).catch(() => false))) {
          await archive.attachFile(m, await source.downloadMedia(raw), imageExt(m.mimetype));
        }
      })
      .catch((e) => log(`archive save failed: ${e.message}`));
  };

  const handlers = {
    log,
    onQr: (qr) => { needsLink = true; setState('UNPAIRED'); if (onQr) onQr(qr); },
    onState: (s) => {
      if (s === 'open') { needsLink = false; loggedOut = false; }
      if (s === 'logged_out') { needsLink = true; loggedOut = true; }
      setState(STATE[s] || 'OPENING');
    },
    onContacts: remember,
    // History arrives once, while linking. Unmarked chats go to the archive (last 30 days only); marked chats go on to
    // `onHistory` (the work DB). History carries no download tickets, so old media of unmarked chats cannot be fetched later.
    onHistory: async (h) => {
      remember(h.contacts);
      if (!archive) return onHistory ? onHistory(h) : undefined;
      const seen = new Map();
      const toArchive = [];
      const toWork = [];
      for (const m of h.messages) {
        if (!seen.has(m.chat_id)) seen.set(m.chat_id, await marked(m.chat_id));
        if (seen.get(m.chat_id)) toWork.push(m); else toArchive.push({ msg: m, mediaRef: null });
      }
      if (toArchive.length) await archive.saveMany(toArchive).catch((e) => log(`archive history failed: ${e.message}`));
      if (onHistory) return onHistory({ ...h, messages: toWork, archived: toArchive.length });
    },
    // Both live ("notify") and messages queued while we were offline ("append") are real new messages; the engine dedupes by id.
    onMessage: (m, { raw }) => {
      // The name people chose for themselves comes with their messages; keep it for chats that have no saved name.
      if (!m.from_me && m.sender_name && m.sender_id) remember([{ id: m.sender_id, name: m.sender_name, saved: false }]);
      emit('message', toEngineMessage(m, { names, raw, bookLoaded }));
      archiveLive(m, raw);
    },
    // "Deleted for everyone": the engine already knows how to withdraw what it derived from such a message.
    onDelete: (d) => {
      if (archive) archive.remove(d.id).catch((e) => log(`archive remove failed: ${e.message}`));
      emit('message', { id: d.id, chatId: d.chat_id, from: d.chat_id, type: 'revoked', fromMe: false, isGroupMsg: d.chat_id.endsWith('@g.us') });
    },
    onCall: (c) => emit('call', { peerJid: c.from, id: c.id }),
  };
  const source = injected || createSourceFn({ authDir, ...handlers });

  const denied = (name) => async () => { throw new ReadOnlyViolation(name); };
  const client = {
    onAnyMessage: (fn) => listeners.message.push(fn),
    onStateChanged: (fn) => listeners.state.push(fn),
    onIncomingCall: (fn) => listeners.call.push(fn),
    getConnectionState: async () => state,
    // Chat list: groups are queried from WhatsApp (read-only); direct chats appear with their first message.
    getAllChats: async () => {
      const groups = (await source.socket?.groupFetchAllParticipating?.().catch(() => ({}))) || {};
      return Object.values(groups).filter((g) => g?.id).map((g) => ({ id: g.id, isGroup: true, name: g.subject || null, t: 0 }));
    },
    getAllMessagesInChat: async () => [],
    loadEarlierMessages: async () => null,
    forceRefocus: () => {},
    kill: async () => source.stop(),
    sendText: denied('sendText'),
    sendImage: denied('sendImage'),
    sendFile: denied('sendFile'),
    reply: denied('reply'),
  };

  /** Same role as open-wa's decryptMedia(message): returns the file as a Buffer. */
  const decryptMedia = async (message) => {
    if (message?._localFile) return fs.promises.readFile(message._localFile); // an image the archive already holds
    if (!message?._raw) throw new Error('no downloadable file for this message');
    return source.downloadMedia(message._raw);
  };

  return {
    client,
    decryptMedia,
    ready,                    // resolves with the client once WhatsApp is connected
    start: () => source.start(),
    source,
    archive,
    /** Linking this computer to a WhatsApp account. */
    link: {
      get needed() { return needsLink; },
      /**
       * Ask WhatsApp for an 8-character code for this phone number (digits with country code). The user types the code
       * on the phone: WhatsApp > Linked devices > Link a device > Link with phone number instead.
       */
      pair: async (phone) => {
        const digits = String(phone || '').replace(/[^0-9]/g, '');
        if (digits.length < 9 || digits.length > 15) throw new Error('bad phone number');
        if (state === 'CONNECTED') throw new Error('already linked');
        if (loggedOut) { loggedOut = false; await source.relink(); await new Promise((r) => setTimeout(r, 2500)); }
        if (!source.socket) throw new Error('not ready yet');
        return source.socket.requestPairingCode(digits);
      },
    },
    /** Re-read the phone's saved contact names from WhatsApp (they arrive through onContacts). */
    refreshContacts: () => source.refreshContacts(),
    /**
     * A chat was just marked: give the engine the last 24 hours of it from the archive, as if they had just arrived.
     * `handle` is the engine's own message handler, so voice notes get transcribed, images described, and so on.
     */
    promote: (chat_id, handle, opts) => (archive
      ? archive.promote(chat_id, (row) => {
        const m = toEngineMessage(rowToMessage(row), { names, bookLoaded, raw: unpackTicket(row.media_ref) || undefined });
        const file = archive.fileOf(row);
        if (file) m._localFile = file; // no need to ask WhatsApp for the picture again
        return handle(m);
      }, opts)
      : Promise.resolve(0)),
    get state() { return state; },
  };
}
