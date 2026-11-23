import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createIngest } from '../ingest.js';

const DM = '972501234567@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const msg = (over = {}) => ({
  id: 'M1', chat_id: DM, sender_id: DM, sender_name: 'Dana', content: 'hi', type: 'chat',
  timestamp: 1700000000, from_me: 0, is_group: false, ...over,
});

function fakeDb() {
  const calls = [];
  return {
    calls,
    saveMessage: async (m) => { calls.push(['saveMessage', m.id]); },
    upsertChat: async (c) => { calls.push(['upsertChat', c.chat_id, c.name]); },
    updateMessageContent: async (id, content) => { calls.push(['update', id, content]); },
    getDb: async () => ({
      exec: async (sql) => { calls.push(['sql', sql]); },
      run: async (sql, params) => { calls.push(['run', sql.split(' WHERE')[0], ...params]); },
    }),
  };
}

test('saved contact names name direct chats and beat push names; a push name never overrides a saved one', async () => {
  const db = fakeDb();
  const ing = createIngest({ db });
  ing.handlers.onHistory({
    messages: [msg({ id: 'C1', sender_name: 'PushName' })],
    chats: [{ chat_id: DM, name: null, is_group: false, last_ts: 1 }],
    contacts: [{ id: DM, alt: '111@lid', name: 'Dana (saved)', saved: true }],
    isLatest: false,
  });
  ing.handlers.onContacts([{ id: DM, alt: null, name: 'SomethingElse', saved: false }]); // must be ignored
  await ing.idle();
  const upserts = db.calls.filter((c) => c[0] === 'upsertChat').map((c) => [c[1], c[2]]);
  assert.deepStrictEqual(upserts, [[DM, 'Dana (saved)'], [DM, 'Dana (saved)']]);
  const updates = db.calls.filter((c) => c[0] === 'run');
  assert.ok(updates.some((c) => c.includes('Dana (saved)') && c.includes('111@lid')), 'alt (LID) id is named too');
  assert.ok(!updates.some((c) => c.includes('SomethingElse')));
});

test('a push-name-only contact only fills chats that have no name', async () => {
  const db = fakeDb();
  const ing = createIngest({ db });
  ing.handlers.onContacts([{ id: DM, alt: null, name: 'Pushy', saved: false }]);
  await ing.idle();
  const upd = db.calls.find((c) => c[0] === 'run');
  assert.ok(upd[1].startsWith('UPDATE chats SET name = ?') && upd.includes('Pushy'));
  assert.ok(db.calls.some((c) => c[0] === 'run'));
});

test('duplicates are counted, and unknown content types are listed', async () => {
  const db = fakeDb();
  let n = 0;
  db.saveMessage = async () => ({ changes: n++ === 0 ? 1 : 0 });
  const ing = createIngest({ db });
  ing.handlers.onMessage(msg({ id: 'D1' }), { live: false });
  ing.handlers.onMessage(msg({ id: 'D1' }), { live: false });
  ing.handlers.onMessage(msg({ id: 'O1', type: 'other', raw_kind: 'albumMessage' }), { live: false });
  await ing.idle();
  assert.deepStrictEqual([ing.stats.saved, ing.stats.duplicates], [1, 2]);
  assert.deepStrictEqual(ing.stats.otherKinds, { albumMessage: 1 });
});

test('live message is saved and reported; own messages never name the chat', async () => {
  const db = fakeDb();
  const seen = [];
  const ing = createIngest({ db, onLive: (m) => seen.push(m.id) });
  ing.handlers.onMessage(msg(), { live: true });
  ing.handlers.onMessage(msg({ id: 'M2', from_me: 1, sender_name: 'MyOwnName' }), { live: true });
  ing.handlers.onMessage(msg({ id: 'M3', chat_id: GROUP, is_group: true, sender_name: 'Someone' }), { live: false });
  await ing.idle();
  assert.deepStrictEqual(seen, ['M1', 'M2']); // history (live:false) is not reported as live
  const names = db.calls.filter((c) => c[0] === 'upsertChat').map((c) => c[2]);
  assert.deepStrictEqual(names, ['Dana', null, null]);
});

test('a history batch is one transaction, chats before messages', async () => {
  const db = fakeDb();
  const ing = createIngest({ db });
  ing.handlers.onHistory({
    messages: [msg({ id: 'A' }), msg({ id: 'B' })],
    chats: [{ chat_id: DM, name: 'Dana', is_group: false, last_ts: 1 }],
    isLatest: true,
  });
  await ing.idle();
  const kinds = db.calls.map((c) => c[0] === 'sql' ? c[1] : c[0]);
  assert.strictEqual(kinds[0], 'BEGIN IMMEDIATE');
  assert.strictEqual(kinds.at(-1), 'COMMIT');
  assert.ok(kinds.indexOf('upsertChat') < kinds.indexOf('saveMessage'));
  assert.strictEqual(ing.stats.historyDone, true);
});

test('a failing batch is rolled back and the queue keeps working', async () => {
  const db = fakeDb();
  let fail = true;
  db.saveMessage = async (m) => { if (fail) throw new Error('disk full'); db.calls.push(['saveMessage', m.id]); };
  const ing = createIngest({ db });
  ing.handlers.onHistory({ messages: [msg()], chats: [], isLatest: false });
  await ing.idle();
  assert.ok(db.calls.some((c) => c[1] === 'ROLLBACK'));
  assert.strictEqual(ing.stats.errors, 1);
  fail = false;
  ing.handlers.onMessage(msg({ id: 'LATER' }), { live: true });
  await ing.idle();
  assert.ok(db.calls.some((c) => c[0] === 'saveMessage' && c[1] === 'LATER'));
});

test('delete is reported but the message stays in the database; edit updates the text', async () => {
  const db = fakeDb();
  const deleted = [];
  const ing = createIngest({ db, onDelete: (d) => deleted.push(d.id) });
  ing.handlers.onDelete({ id: 'GONE', chat_id: DM });
  ing.handlers.onEdit({ id: 'E1', chat_id: DM, content: 'fixed' });
  await ing.idle();
  assert.deepStrictEqual(deleted, ['GONE']);
  assert.deepStrictEqual(db.calls, [['update', 'E1', 'fixed']]);
});

test('group names come from a read-only group query', async () => {
  const db = fakeDb();
  const ing = createIngest({ db });
  await ing.fillGroupNames({ groupFetchAllParticipating: async () => ({ [GROUP]: { id: GROUP, subject: 'משפחה' }, x: { id: 'y@g.us' } }) });
  const chats = db.calls.filter((c) => c[0] === 'upsertChat');
  assert.deepStrictEqual(chats, [['upsertChat', GROUP, 'משפחה']]);
});

test('real db.js: messages land in the existing tables, duplicates are ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-db-'));
  process.env.BOT_DATA_DIR = dir; // must be set before db.js is loaded
  const db = createRequire(import.meta.url)('../../db.js');
  const ing = createIngest({ db });
  const batch = [msg({ id: 'R1' }), msg({ id: 'R2', timestamp: 1700000100, content: 'שלום' }), msg({ id: 'R1' })];
  ing.handlers.onHistory({ messages: batch, chats: [{ chat_id: DM, name: 'Dana', is_group: false, last_ts: 1700000100 }], isLatest: true });
  await ing.idle();
  assert.strictEqual(ing.stats.errors, 0);
  const raw = await db.getDb();
  assert.strictEqual((await raw.get('SELECT COUNT(*) n FROM messages')).n, 2);
  assert.strictEqual((await raw.get('SELECT content FROM messages WHERE id = ?', ['R2'])).content, 'שלום');
  const chat = await db.getChat(DM);
  assert.deepStrictEqual([chat.name, chat.last_message_at], ['Dana', 1700000100]);
  await raw.close();
  assert.ok(fs.existsSync(path.join(dir, 'whatsapp_history.db')), 'database was created in BOT_DATA_DIR, not in the project');
});
