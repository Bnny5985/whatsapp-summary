import test from 'node:test';
import assert from 'node:assert';
import { createCompat, toEngineMessage } from '../compat.js';
import { ReadOnlyViolation } from '../readonly.js';

const DM = '972501234567@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const wait = () => new Promise((r) => setTimeout(r, 5));

function setup(extra = {}) {
  const fake = { calls: [], started: false, stopped: false, socket: { groupFetchAllParticipating: async () => ({ [GROUP]: { id: GROUP, subject: 'משפחה' } }) },
    start: async () => { fake.started = true; }, stop: () => { fake.stopped = true; }, downloadMedia: async (raw) => Buffer.from(`file:${raw.id}`) };
  let handlers;
  const compat = createCompat({ authDir: 'x', createSourceFn: (o) => { handlers = o; return fake; }, ...extra });
  return { compat, fake, h: () => handlers };
}
const nmsg = (over = {}) => ({ id: 'M1', chat_id: DM, sender_id: DM, sender_name: 'Dana', content: 'שלום', type: 'chat', timestamp: 1700000000, from_me: 0, is_group: false, has_media: false, ...over });

test('live and offline-queued messages reach the engine in the shape it reads; history batches do not', async () => {
  const { compat, h } = setup();
  const got = [];
  compat.client.onAnyMessage((m) => got.push(m));
  h().onMessage(nmsg(), { live: true, raw: { id: 'RAW' } });
  h().onMessage(nmsg({ id: 'QUEUED' }), { live: false }); // delivered on reconnect for the time we were offline
  h().onHistory({ messages: [nmsg({ id: 'HIST' })], chats: [], contacts: [] });
  await wait();
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[1].id, 'QUEUED');
  const m = got[0];
  assert.deepStrictEqual(
    [m.id, m.chatId, m.from, m.fromMe, m.type, m.body, m.caption, m.timestamp, m.isGroupMsg, m.sender.id, m.sender.pushname],
    ['M1', DM, DM, false, 'chat', 'שלום', undefined, 1700000000, false, DM, 'Dana']);
  assert.deepStrictEqual(m._raw, { id: 'RAW' });
});

test('group message: author, caption for media, mimetype only for real media', () => {
  const g = toEngineMessage(nmsg({ chat_id: GROUP, is_group: true, sender_id: '972509999999@s.whatsapp.net', type: 'image', content: 'תמונה', has_media: true, mimetype: 'image/jpeg' }));
  assert.deepStrictEqual([g.author, g.isGroupMsg, g.body, g.caption, g.mimetype], ['972509999999@s.whatsapp.net', true, undefined, 'תמונה', 'image/jpeg']);
  const s = toEngineMessage(nmsg({ type: 'sticker', has_media: true, mimetype: 'image/webp', content: '' }));
  assert.strictEqual(s.mimetype, undefined);
});

test('with the address book loaded: saved contact = known, any other number = not saved', async () => {
  const { compat, h } = setup();
  const got = [];
  compat.client.onAnyMessage((m) => got.push(m));
  h().onContacts([{ id: DM, alt: null, name: 'דנה', saved: true }]);
  h().onMessage(nmsg(), { live: true });
  h().onMessage(nmsg({ id: 'M2', chat_id: '972520000000@s.whatsapp.net', sender_id: '972520000000@s.whatsapp.net' }), { live: true });
  await wait();
  assert.strictEqual(got[0].sender.isMyContact, true);
  assert.strictEqual(got[0].chat.name, 'דנה');
  assert.strictEqual(got[1].sender.isMyContact, false);
});

test('without the address book nobody is called "not saved" (the engine would start listening to everyone)', async () => {
  const { compat, h } = setup();
  const got = [];
  compat.client.onAnyMessage((m) => got.push(m));
  h().onMessage(nmsg(), { live: true });       // carries only the name the person chose
  h().onMessage(nmsg({ id: 'M2' }), { live: true });
  await wait();
  assert.ok(!('isMyContact' in got[0].sender));
  assert.ok(!('isMyContact' in got[1].sender), 'still unknown after we learned the chosen name');
  assert.strictEqual(got[1].chat.name, 'Dana', 'the chosen name is used until a saved one is known');
});

test('names survive a restart: changes are reported once, earlier ones are loaded back', async () => {
  const stored = [];
  const first = setup({ onContacts: (l) => stored.push(...l) });
  first.h().onContacts([{ id: DM, alt: '111@lid', name: 'דנה', saved: true }]);
  first.h().onContacts([{ id: DM, alt: '111@lid', name: 'דנה', saved: true }]); // nothing new
  first.h().onContacts([{ id: DM, alt: null, name: 'Dana', saved: false }]);    // a chosen name must not replace the saved one
  await wait();
  assert.deepStrictEqual(stored.map((x) => [x.id, x.name, x.saved]), [[DM, 'דנה', true], ['111@lid', 'דנה', true]]);
  const second = setup({ knownContacts: stored });
  const got = [];
  second.compat.client.onAnyMessage((m) => got.push(m));
  second.h().onMessage(nmsg({ sender_name: null }), { live: true });
  await wait();
  assert.deepStrictEqual([got[0].chat.name, got[0].sender.isMyContact], ['דנה', true]);
});

test('connection states use the names the watchdog expects, and ready resolves on connect', async () => {
  const { compat, h } = setup();
  const states = [];
  compat.client.onStateChanged((s) => states.push(s));
  assert.strictEqual(await compat.client.getConnectionState(), 'OPENING');
  h().onQr('qr');
  h().onState('open');
  h().onState('reconnecting');
  h().onState('open');
  h().onState('logged_out');
  await wait();
  assert.deepStrictEqual(states, ['UNPAIRED', 'CONNECTED', 'TIMEOUT', 'CONNECTED', 'UNPAIRED']);
  assert.strictEqual(await compat.ready, compat.client);
  assert.strictEqual(await compat.client.getConnectionState(), 'UNPAIRED');
});

test('delete for everyone arrives as a revoked message; calls as peerJid', async () => {
  const { compat, h } = setup();
  const msgs = []; const calls = [];
  compat.client.onAnyMessage((m) => msgs.push(m));
  compat.client.onIncomingCall((c) => calls.push(c));
  h().onDelete({ id: 'GONE', chat_id: GROUP });
  h().onCall({ id: 'C1', from: DM });
  await wait();
  assert.deepStrictEqual([msgs[0].type, msgs[0].id, msgs[0].chatId, msgs[0].isGroupMsg], ['revoked', 'GONE', GROUP, true]);
  assert.strictEqual(calls[0].peerJid, DM);
});

test('sending is impossible', async () => {
  const { compat } = setup();
  for (const name of ['sendText', 'sendImage', 'sendFile', 'reply']) {
    await assert.rejects(() => compat.client[name](DM, 'x'), ReadOnlyViolation, name);
  }
});

test('old history is not available on demand; chat list comes from a group query', async () => {
  const { compat } = setup();
  assert.deepStrictEqual(await compat.client.getAllMessagesInChat(DM), []);
  assert.deepStrictEqual(await compat.client.getAllChats(), [{ id: GROUP, isGroup: true, name: 'משפחה', t: 0 }]);
});

test('decryptMedia downloads through the source and needs the original message', async () => {
  const { compat, h } = setup();
  const got = [];
  compat.client.onAnyMessage((m) => got.push(m));
  h().onMessage(nmsg({ type: 'image', has_media: true }), { live: true, raw: { id: 'RAW1' } });
  await wait();
  assert.strictEqual((await compat.decryptMedia(got[0])).toString(), 'file:RAW1');
  await assert.rejects(() => compat.decryptMedia({ id: 'no-raw' }), /no downloadable file/);
});

test('kill stops the source; a listener that throws does not break the others', async () => {
  const { compat, fake, h } = setup();
  const seen = [];
  compat.client.onAnyMessage(() => { throw new Error('boom'); });
  compat.client.onAnyMessage((m) => seen.push(m.id));
  h().onMessage(nmsg(), { live: true });
  await wait();
  assert.deepStrictEqual(seen, ['M1']);
  await compat.client.kill();
  assert.strictEqual(fake.stopped, true);
});

test('linking: asks WhatsApp for a pairing code only when it makes sense', async () => {
  const asked = [];
  const fake = { started: false, socket: { requestPairingCode: async (n) => { asked.push(n); return 'ABCD1234'; } }, start: async () => {}, stop() {}, relink: async () => { fake.relinked = true; } };
  let h;
  const compat = createCompat({ authDir: 'x', createSourceFn: (o) => { h = o; return fake; } });
  assert.strictEqual(compat.link.needed, false);
  h.onQr('qr');
  assert.strictEqual(compat.link.needed, true);
  await assert.rejects(() => compat.link.pair('12'), /bad phone number/);
  assert.strictEqual(await compat.link.pair('+972 50-123-4567'), 'ABCD1234');
  assert.deepStrictEqual(asked, ['972501234567'], 'digits only');
  h.onState('open');
  assert.strictEqual(compat.link.needed, false);
  await assert.rejects(() => compat.link.pair('972501234567'), /already linked/);
});

test('linking again after the phone removed this computer starts from a clean login', async () => {
  const fake = { socket: { requestPairingCode: async () => 'WXYZ5678' }, start: async () => {}, stop() {}, relink: async () => { fake.relinked = true; } };
  let h;
  const compat = createCompat({ authDir: 'x', createSourceFn: (o) => { h = o; return fake; } });
  h.onState('logged_out');
  assert.strictEqual(compat.link.needed, true);
  assert.strictEqual(compat.state, 'UNPAIRED');
  assert.strictEqual(await compat.link.pair('972501234567'), 'WXYZ5678');
  assert.strictEqual(fake.relinked, true);
});
