import test from 'node:test';
import assert from 'node:assert';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { createArchive } from '../archive.js';
import { createCompat } from '../compat.js';
import { packTicket, unpackTicket } from '../source.js';

const DAY = 86400;
const NOW = 1_800_000_000;
const DM = '972501234567@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const msg = (over = {}) => ({ id: 'M1', chat_id: DM, sender_id: DM, sender_name: 'Dana', content: 'שלום', type: 'chat', timestamp: NOW - 100, from_me: 0, is_group: false, has_media: false, ...over });

async function freshArchive(extra = {}) {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  return { db, archive: createArchive({ db, now: () => NOW, ...extra }) };
}

test('keeps a message once, and refuses ones older than the retention window', async () => {
  const { archive } = await freshArchive();
  assert.strictEqual(await archive.save(msg()), true);
  assert.strictEqual(await archive.save(msg()), false, 'same id twice');
  assert.strictEqual(await archive.save(msg({ id: 'OLD', timestamp: NOW - 31 * DAY })), false);
  assert.strictEqual(await archive.save(msg({ id: 'EDGE', timestamp: NOW - 29 * DAY })), true);
  assert.deepStrictEqual(await archive.stats(), { messages: 2, chats: 1, oldest: NOW - 29 * DAY, images: 0, retentionDays: 30 });
});

test('purge deletes what fell out of the window; the window is configurable', async () => {
  let t = NOW;
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  const archive = createArchive({ db, retentionDays: 30, now: () => t });
  await archive.save(msg({ id: 'A', timestamp: NOW - DAY }));
  await archive.save(msg({ id: 'B', timestamp: NOW - 20 * DAY }));
  t = NOW + 15 * DAY; // time passes
  assert.strictEqual(await archive.purge(), 1); // B is now 35 days old
  assert.strictEqual((await archive.stats()).messages, 1);
  const short = createArchive({ db: await open({ filename: ':memory:', driver: sqlite3.Database }), retentionDays: 7, now: () => NOW });
  assert.strictEqual(await short.save(msg({ timestamp: NOW - 8 * DAY })), false);
});

test('saveMany stores a batch in one go and skips the old ones', async () => {
  const { archive } = await freshArchive();
  const added = await archive.saveMany([
    { msg: msg({ id: '1' }) }, { msg: msg({ id: '2', chat_id: GROUP, is_group: true }) },
    { msg: msg({ id: '3', timestamp: NOW - 40 * DAY }) }, { msg: msg({ id: '1' }) },
  ]);
  assert.strictEqual(added, 2);
  assert.strictEqual((await archive.stats()).chats, 2);
});

test('a message deleted for everyone leaves the archive; clear() empties it', async () => {
  const { archive } = await freshArchive();
  await archive.save(msg({ id: 'X' }));
  await archive.save(msg({ id: 'Y' }));
  assert.strictEqual(await archive.remove('X'), 1);
  assert.strictEqual((await archive.stats()).messages, 1);
  await archive.clear();
  assert.strictEqual((await archive.stats()).messages, 0);
});

test('promote hands over only the last 24 hours of that chat, oldest first', async () => {
  const { archive } = await freshArchive();
  await archive.save(msg({ id: 'new2', timestamp: NOW - 60 }));
  await archive.save(msg({ id: 'new1', timestamp: NOW - 3600 }));
  await archive.save(msg({ id: 'old', timestamp: NOW - 25 * 3600 }));
  await archive.save(msg({ id: 'other', chat_id: GROUP, timestamp: NOW - 60 }));
  const got = [];
  const n = await archive.promote(DM, (row) => got.push(row.id));
  assert.deepStrictEqual(got, ['new1', 'new2']);
  assert.strictEqual(n, 2);
  assert.strictEqual((await archive.stats()).messages, 4, 'rows stay until the retention window removes them');
});

test('one failing message does not stop the rest of a promotion', async () => {
  const { archive } = await freshArchive();
  await archive.save(msg({ id: 'a' }));
  await archive.save(msg({ id: 'b', timestamp: NOW - 50 }));
  const done = [];
  const n = await archive.promote(DM, (row) => { if (row.id === 'a') throw new Error('boom'); done.push(row.id); });
  assert.deepStrictEqual(done, ['b']);
  assert.strictEqual(n, 1);
});

test('download ticket survives being stored as text, binary keys included', () => {
  const raw = { key: { id: 'K', remoteJid: DM, fromMe: false }, message: { audioMessage: { url: 'https://x', mediaKey: Buffer.from([1, 2, 3]), jpegThumbnail: Buffer.from('big'), mimetype: 'audio/ogg' } } };
  const back = unpackTicket(packTicket(raw));
  assert.strictEqual(back.key.id, 'K');
  assert.deepStrictEqual([...back.message.audioMessage.mediaKey], [1, 2, 3]);
  assert.strictEqual(back.message.audioMessage.jpegThumbnail, undefined, 'thumbnails are not kept');
  assert.strictEqual(packTicket({ key: {} }), null);
  assert.strictEqual(unpackTicket(null), null);
});

// ---- the compat layer decides what goes where ----
async function compatWith({ marked = new Set() } = {}) {
  const { archive } = await freshArchive();
  const fake = { start: async () => {}, stop() {}, socket: null, downloadMedia: async () => Buffer.from('x') };
  let h;
  const history = [];
  const compat = createCompat({
    authDir: 'x', archive, isMarked: async (id) => marked.has(id), onHistory: (b) => history.push(b),
    createSourceFn: (o) => { h = o; return fake; },
  });
  const seen = [];
  compat.client.onAnyMessage((m) => seen.push(m));
  return { compat, archive, h: () => h, seen, history };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('live message: unmarked chat -> archive (and still shown to the engine); marked chat -> engine only', async () => {
  const { archive, h, seen } = await compatWith({ marked: new Set([GROUP]) });
  h().onMessage(msg({ id: 'U' }), { live: true, raw: { key: { id: 'U' }, message: {} } });
  h().onMessage(msg({ id: 'M', chat_id: GROUP, is_group: true }), { live: true });
  await settle(); await archive.idle();
  assert.strictEqual(seen.length, 2, 'the engine sees both: it registers the chat in the list');
  assert.deepStrictEqual((await archive.recent(DM, 0)).map((r) => r.id), ['U']);
  assert.deepStrictEqual(await archive.recent(GROUP, 0), []);
});

test('media of an unmarked chat is archived with a download ticket; text is not', async () => {
  const { archive, h } = await compatWith();
  const raw = { key: { id: 'V', remoteJid: DM }, message: { audioMessage: { mediaKey: Buffer.from([9]) } } };
  h().onMessage(msg({ id: 'V', type: 'ptt', has_media: true, mimetype: 'audio/ogg', content: '' }), { live: true, raw });
  h().onMessage(msg({ id: 'T' }), { live: true, raw: { key: { id: 'T' }, message: { conversation: 'hi' } } });
  await settle(); await archive.idle();
  const rows = Object.fromEntries((await archive.recent(DM, 0)).map((r) => [r.id, r]));
  assert.ok(rows.V.media_ref && rows.V.media_ref.includes('mediaKey'));
  assert.strictEqual(rows.T.media_ref, null);
});

test('history while linking: unmarked chats go to the archive, marked chats go on to the work DB', async () => {
  const { archive, h, history } = await compatWith({ marked: new Set([GROUP]) });
  await h().onHistory({ messages: [msg({ id: 'a' }), msg({ id: 'b', chat_id: GROUP, is_group: true }), msg({ id: 'old', timestamp: NOW - 40 * DAY })], chats: [{ id: DM }], contacts: [] });
  assert.deepStrictEqual((await archive.recent(DM, 0)).map((r) => r.id), ['a']);
  assert.deepStrictEqual(history[0].messages.map((m) => m.id), ['b']);
  assert.strictEqual(history[0].chats.length, 1, 'the chat list still goes through, so every chat can be picked');
});

test('a delete-for-everyone removes the archived copy', async () => {
  const { archive, h } = await compatWith();
  h().onMessage(msg({ id: 'D' }), { live: true });
  await settle(); await archive.idle();
  h().onDelete({ id: 'D', chat_id: DM });
  await settle(); await archive.idle();
  assert.deepStrictEqual(await archive.recent(DM, 0), []);
});

test('promote gives the engine archived messages in the shape it reads, with the file ticket', async () => {
  const { compat, archive, h } = await compatWith();
  const raw = { key: { id: 'V', remoteJid: DM }, message: { audioMessage: { mediaKey: Buffer.from([7]) } } };
  h().onMessage(msg({ id: 'V', type: 'ptt', has_media: true, mimetype: 'audio/ogg', content: '', timestamp: NOW - 10 }), { live: true, raw });
  await settle(); await archive.idle();
  const got = [];
  const n = await compat.promote(DM, (m) => got.push(m));
  assert.strictEqual(n, 1);
  assert.deepStrictEqual([got[0].id, got[0].chatId, got[0].type, got[0].fromMe], ['V', DM, 'ptt', false]);
  assert.deepStrictEqual([...got[0]._raw.message.audioMessage.mediaKey], [7]);
  const file = await compat.decryptMedia(got[0]);
  assert.ok(Buffer.isBuffer(file));
});

test('without an archive nothing changes: everything goes to the engine, promote does nothing', async () => {
  const fake = { start: async () => {}, stop() {}, socket: null };
  let h;
  const compat = createCompat({ authDir: 'x', createSourceFn: (o) => { h = o; return fake; } });
  const seen = [];
  compat.client.onAnyMessage((m) => seen.push(m));
  h.onMessage(msg(), { live: true });
  await settle();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(await compat.promote(DM, () => {}), 0);
});

test('if the "is it marked?" check fails, the chat is treated as marked (never archive by accident)', async () => {
  const { archive } = await freshArchive();
  const fake = { start: async () => {}, stop() {}, socket: null };
  let h;
  createCompat({ authDir: 'x', archive, isMarked: async () => { throw new Error('db down'); }, createSourceFn: (o) => { h = o; return fake; } });
  h.onMessage(msg(), { live: true });
  await settle(); await archive.idle();
  assert.strictEqual((await archive.stats()).messages, 0);
});

// ---- "keep images in the archive" (per chat) ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function withMedia({ keep = new Set(), marked = new Set() } = {}) {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-media-'));
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  const archive = createArchive({ db, mediaDir, now: () => NOW });
  const downloads = [];
  const fake = { start: async () => {}, stop() {}, socket: null, downloadMedia: async (raw) => { downloads.push(raw.key.id); return Buffer.from(`pic:${raw.key.id}`); } };
  let h;
  const compat = createCompat({ authDir: 'x', archive, isMarked: async (c) => marked.has(c), keepImages: async (c) => keep.has(c), createSourceFn: (o) => { h = o; return fake; } });
  return { compat, archive, mediaDir, downloads, h: () => h };
}
const image = (id, over = {}) => msg({ id, type: 'image', has_media: true, mimetype: 'image/jpeg', content: '', timestamp: NOW - 10, ...over });
const rawOf = (id) => ({ key: { id, remoteJid: DM }, message: { imageMessage: { mediaKey: Buffer.from([1]) } } });

test('image option ON: the picture file is stored; OFF: nothing is downloaded', async () => {
  const { archive, mediaDir, downloads, h } = await withMedia({ keep: new Set([GROUP]) });
  h().onMessage(image('P1', { chat_id: GROUP, is_group: true }), { live: true, raw: rawOf('P1') });
  h().onMessage(image('P2'), { live: true, raw: rawOf('P2') }); // DM: option off
  await settle(); await settle(); await archive.idle();
  assert.deepStrictEqual(downloads, ['P1']);
  const [row] = await archive.recent(GROUP, 0);
  assert.ok(row.media_path.endsWith('.jpg'));
  assert.strictEqual(fs.readFileSync(path.join(mediaDir, row.media_path), 'utf8'), 'pic:P1');
  assert.strictEqual((await archive.recent(DM, 0))[0].media_path, null);
  assert.strictEqual((await archive.stats()).images, 1);
});

test('image option ON but the chat is marked: the archive stores nothing (the engine keeps it)', async () => {
  const { archive, downloads, h } = await withMedia({ keep: new Set([DM]), marked: new Set([DM]) });
  h().onMessage(image('P3'), { live: true, raw: rawOf('P3') });
  await settle(); await archive.idle();
  assert.deepStrictEqual(downloads, []);
  assert.strictEqual((await archive.stats()).messages, 0);
});

test('the picture file is deleted with its row: purge, delete-for-everyone, clear', async () => {
  let t = NOW;
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-media-'));
  const archive = createArchive({ db: await open({ filename: ':memory:', driver: sqlite3.Database }), mediaDir, now: () => t });
  const put = async (id, ts) => { await archive.save(msg({ id, type: 'image', timestamp: ts })); return archive.attachFile({ id, chat_id: DM }, Buffer.from('x'), 'jpg'); };
  const a = await put('A', NOW - 20 * DAY), b = await put('B', NOW - 1 * DAY), c = await put('C', NOW - 1 * DAY);
  const exists = (rel) => fs.existsSync(path.join(mediaDir, rel));
  await archive.remove('C'); await settle();
  assert.strictEqual(exists(c), false);
  t = NOW + 15 * DAY; // A is now 35 days old
  await archive.purge(); await settle();
  assert.strictEqual(exists(a), false);
  assert.strictEqual(exists(b), true);
  await archive.clear(); await settle();
  assert.strictEqual(exists(b), false);
});

test('a file cannot be attached to a message the archive does not hold', async () => {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-media-'));
  const archive = createArchive({ db: await open({ filename: ':memory:', driver: sqlite3.Database }), mediaDir, now: () => NOW });
  assert.strictEqual(await archive.attachFile({ id: 'GHOST', chat_id: DM }, Buffer.from('x')), null);
  assert.deepStrictEqual(fs.readdirSync(mediaDir), []);
});

test('promote: the engine reads the stored picture from disk, not from WhatsApp', async () => {
  const { compat, archive, h, downloads } = await withMedia({ keep: new Set([DM]) });
  h().onMessage(image('P9'), { live: true, raw: rawOf('P9') });
  await settle(); await settle(); await archive.idle();
  assert.deepStrictEqual(downloads, ['P9']);
  const got = [];
  await compat.promote(DM, (m) => got.push(m));
  assert.ok(got[0]._localFile);
  assert.strictEqual((await compat.decryptMedia(got[0])).toString(), 'pic:P9');
  assert.deepStrictEqual(downloads, ['P9'], 'no second download');
});
