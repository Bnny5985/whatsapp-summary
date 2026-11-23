import test from 'node:test';
import assert from 'node:assert';
import { normalizeMessage, describeProtocol, normalizeChat, normalizeContact } from '../normalize.js';

const DM = '972501234567@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const key = (over = {}) => ({ remoteJid: DM, fromMe: false, id: 'ID1', ...over });

test('direct text message', () => {
  const m = normalizeMessage({ key: key(), pushName: 'Dana', messageTimestamp: 1700000000, message: { conversation: 'שלום' } });
  assert.deepStrictEqual(
    { id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, sender_name: m.sender_name, content: m.content, type: m.type, timestamp: m.timestamp, from_me: m.from_me, is_group: m.is_group },
    { id: 'ID1', chat_id: DM, sender_id: DM, sender_name: 'Dana', content: 'שלום', type: 'chat', timestamp: 1700000000, from_me: 0, is_group: false });
});

test('a direct chat under an anonymous @lid id is filed under the phone-number id', () => {
  const m = normalizeMessage({ key: key({ remoteJid: '1234567890@lid', remoteJidAlt: DM }), messageTimestamp: 1700000000, message: { conversation: 'היי' } });
  assert.strictEqual(m.chat_id, DM);
  assert.strictEqual(m.sender_id, DM);
  const noAlt = normalizeMessage({ key: key({ remoteJid: '1234567890@lid' }), messageTimestamp: 1700000000, message: { conversation: 'היי' } });
  assert.strictEqual(noAlt.chat_id, '1234567890@lid'); // nothing to map to: keep it as is
});

test('group message takes the participant as sender; Long timestamps work', () => {
  const m = normalizeMessage({
    key: key({ remoteJid: GROUP, participant: '972509999999@s.whatsapp.net' }),
    messageTimestamp: { toNumber: () => 1700000123 },
    message: { extendedTextMessage: { text: 'hello', contextInfo: { stanzaId: 'QUOTED' } } },
  });
  assert.strictEqual(m.sender_id, '972509999999@s.whatsapp.net');
  assert.strictEqual(m.is_group, true);
  assert.strictEqual(m.timestamp, 1700000123);
  assert.strictEqual(m.quoted_id, 'QUOTED');
});

test('media types and captions', () => {
  const img = normalizeMessage({ key: key(), message: { imageMessage: { caption: 'תמונה' } } });
  assert.deepStrictEqual([img.type, img.content, img.has_media], ['image', 'תמונה', true]);
  const ptt = normalizeMessage({ key: key(), message: { audioMessage: { ptt: true } } });
  assert.deepStrictEqual([ptt.type, ptt.has_media], ['ptt', true]);
  const audio = normalizeMessage({ key: key(), message: { audioMessage: { ptt: false } } });
  assert.strictEqual(audio.type, 'audio');
});

test('wrapped (disappearing-messages) text is unwrapped', () => {
  const m = normalizeMessage({ key: key(), message: { ephemeralMessage: { message: { conversation: 'secret' } } } });
  assert.strictEqual(m.content, 'secret');
});

test('own message', () => {
  const m = normalizeMessage({ key: key({ fromMe: true }), message: { conversation: 'x' } });
  assert.deepStrictEqual([m.from_me, m.sender_id], [1, 'me']);
});

test('non-messages are ignored', () => {
  assert.strictEqual(normalizeMessage({ key: key({ remoteJid: 'status@broadcast' }), message: { conversation: 'x' } }), null);
  assert.strictEqual(normalizeMessage({ key: key(), message: { reactionMessage: { text: '👍' } } }), null);
  assert.strictEqual(normalizeMessage({ key: key(), message: null }), null);
  assert.strictEqual(normalizeMessage(null), null);
});

test('delete and edit notices', () => {
  const del = describeProtocol({ key: key(), message: { protocolMessage: { type: 0, key: { remoteJid: DM, id: 'GONE' } } } });
  assert.deepStrictEqual(del, { kind: 'delete', id: 'GONE', chat_id: DM });
  const edit = describeProtocol({ key: key(), message: { protocolMessage: { type: 14, key: { remoteJid: DM, id: 'E1' }, editedMessage: { conversation: 'fixed' } } } });
  assert.deepStrictEqual(edit, { kind: 'edit', id: 'E1', chat_id: DM, content: 'fixed' });
  assert.strictEqual(describeProtocol({ key: key(), message: { conversation: 'plain' } }), null);
});

test('contacts: saved name beats push name; nameless contacts are dropped', () => {
  assert.deepStrictEqual(normalizeContact({ id: DM, name: 'Dana', notify: 'D', lid: '1@lid' }), { id: DM, alt: '1@lid', name: 'Dana', saved: true });
  assert.deepStrictEqual(normalizeContact({ id: DM, notify: 'D' }), { id: DM, alt: null, name: 'D', saved: false });
  assert.strictEqual(normalizeContact({ id: DM }), null);
  assert.strictEqual(normalizeContact(null), null);
});

test('unknown content keeps its Baileys type for diagnosis', () => {
  const m = normalizeMessage({ key: key(), message: { albumMessage: { expectedImageCount: 3 } } });
  assert.deepStrictEqual([m.type, m.raw_kind], ['other', 'albumMessage']);
});

test('chat summary', () => {
  assert.deepStrictEqual(normalizeChat({ id: GROUP, name: 'משפחה', unreadCount: 3, conversationTimestamp: 1700000000 }),
    { chat_id: GROUP, name: 'משפחה', is_group: true, unread: 3, last_ts: 1700000000 });
  assert.strictEqual(normalizeChat({}), null);
});
