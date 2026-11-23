// Turns Baileys messages into the plain shape the bot's database already uses (db.saveMessage):
//   { id, chat_id, sender_id, sender_name, content, type, timestamp (seconds), from_me }
// plus a few extra fields (is_group, has_media, sender_alt, quoted_id) the engine may use.
import { normalizeMessageContent } from '@whiskeysockets/baileys';

const MEDIA_TYPES = new Set(['image', 'video', 'ptt', 'audio', 'document', 'sticker']);

// Messages that carry no chat content of their own: reactions, key exchange, protocol notices, status updates.
const SKIP_CONTENT = new Set(['reactionMessage', 'senderKeyDistributionMessage', 'protocolMessage', 'messageContextInfo']);

function toSeconds(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toNumber === 'function') return ts.toNumber(); // protobuf Long
  return Number(ts) || 0;
}

function contentKind(m) {
  for (const key of Object.keys(m)) {
    if (SKIP_CONTENT.has(key)) continue;
    return key;
  }
  return null;
}

function typeAndText(kind, m) {
  const body = m[kind] || {};
  switch (kind) {
    case 'conversation': return ['chat', m.conversation || ''];
    case 'extendedTextMessage': return ['chat', body.text || ''];
    case 'imageMessage': return ['image', body.caption || ''];
    case 'videoMessage': return ['video', body.caption || ''];
    case 'audioMessage': return [body.ptt ? 'ptt' : 'audio', ''];
    case 'documentMessage': return ['document', body.caption || body.fileName || ''];
    case 'stickerMessage': return ['sticker', ''];
    case 'locationMessage':
    case 'liveLocationMessage': return ['location', body.name || body.address || ''];
    case 'contactMessage': return ['vcard', body.displayName || ''];
    case 'contactsArrayMessage': return ['vcard', body.displayName || ''];
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': return ['poll', body.name || ''];
    default: return ['other', ''];
  }
}

/** Returns null for anything that is not a real chat message. */
export function normalizeMessage(raw) {
  if (!raw || !raw.key || !raw.message) return null;
  let chatId = raw.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return null;
  // Direct chats can arrive under an anonymous "@lid" id; the phone-number form is what the DB and the user know.
  const alt = raw.key.remoteJidAlt;
  if (chatId.endsWith('@lid') && alt && alt.endsWith('@s.whatsapp.net')) chatId = alt;

  const m = normalizeMessageContent(raw.message); // unwraps ephemeral / view-once / edited wrappers
  if (!m) return null;
  const kind = contentKind(m);
  if (!kind) return null;

  const [type, content] = typeAndText(kind, m);
  const isGroup = chatId.endsWith('@g.us');
  const fromMe = !!raw.key.fromMe;
  const sender = isGroup ? raw.key.participant : (fromMe ? undefined : chatId);
  const quoted = m[kind]?.contextInfo?.stanzaId || null;

  return {
    id: raw.key.id,
    chat_id: chatId,
    sender_id: sender || (fromMe ? 'me' : chatId),
    sender_alt: (isGroup ? raw.key.participantAlt : raw.key.remoteJidAlt) || null, // phone-number form when WhatsApp gives a LID
    sender_name: raw.pushName || null,
    content,
    type,
    timestamp: toSeconds(raw.messageTimestamp),
    from_me: fromMe ? 1 : 0,
    is_group: isGroup,
    has_media: MEDIA_TYPES.has(type),
    quoted_id: quoted,
    raw_kind: kind, // Baileys content type; lets us see what hides behind type "other"
    mimetype: m[kind]?.mimetype || null,
  };
}

/** A contact from the phone's address book (name = saved name) or a push name (notify = name the person chose). */
export function normalizeContact(c) {
  if (!c || !c.id) return null;
  const name = c.name || c.notify || c.verifiedName || null;
  if (!name) return null;
  return { id: c.id, alt: c.lid || c.phoneNumber || null, name, saved: !!c.name };
}

/** A deletion ("delete for everyone") or an edit arrives as a protocol message. */
export function describeProtocol(raw) {
  const p = raw?.message?.protocolMessage;
  if (!p || !p.key) return null;
  const chat_id = p.key.remoteJid || raw.key?.remoteJid;
  if (p.type === 0) return { kind: 'delete', id: p.key.id, chat_id };
  if (p.type === 14) {
    const edited = normalizeMessageContent(p.editedMessage || {}) || {};
    const [, content] = typeAndText(contentKind(edited) || '', edited);
    return { kind: 'edit', id: p.key.id, chat_id, content };
  }
  return null;
}

export function normalizeChat(c) {
  if (!c || !c.id) return null;
  return {
    chat_id: c.id,
    name: c.name || c.displayName || null,
    is_group: c.id.endsWith('@g.us'),
    unread: c.unreadCount || 0,
    last_ts: toSeconds(c.conversationTimestamp),
  };
}
