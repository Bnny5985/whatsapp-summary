// Second line of defence: our own source must not even mention an action method of the WhatsApp socket.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['readonly.js', 'normalize.js', 'source.js', 'ingest.js', 'archive.js', 'compat.js', 'index.js'];

const FORBIDDEN = [
  'sendMessage', 'sendPresenceUpdate', 'readMessages', 'sendReceipt', 'sendReceipts', 'presenceSubscribe',
  'groupParticipantsUpdate', 'groupUpdateSubject', 'groupUpdateDescription', 'groupLeave', 'groupCreate',
  'groupSettingUpdate', 'updateBlockStatus', 'rejectCall', 'createCallLink', 'relayMessage', 'sendNode',
  'chatModify', 'updateProfileStatus', 'updateProfileName', 'updateProfilePicture', 'updateMediaMessage',
  'sendRetryRequest', 'logout', 'sendStatusMentions', 'newsletterCreate', 'addChatLabel',
];

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('no forbidden WhatsApp action is referenced in the source', () => {
  for (const f of FILES) {
    const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const name of FORBIDDEN) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${f} mentions ${name}`);
    }
  }
});

test('source never emits events or exposes the raw socket', () => {
  const src = stripComments(fs.readFileSync(path.join(dir, 'source.js'), 'utf8'));
  assert.ok(!/\.ev\.emit\b/.test(src), 'source.js emits events');
  const returned = src.slice(src.lastIndexOf('return {'));
  assert.ok(!/\braw\b/.test(returned.replace(/raw\?\.end/, '')), 'the raw socket must not be part of the public object');
});

test('only source.js and normalize.js import Baileys', () => {
  for (const f of FILES) {
    const imports = /from '@whiskeysockets\/baileys'/.test(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.strictEqual(imports, f === 'source.js' || f === 'normalize.js', f);
  }
});
