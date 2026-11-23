import test from 'node:test';
import assert from 'node:assert';
import { readOnly, ReadOnlyViolation } from '../readonly.js';

function fakeSocket() {
  const log = [];
  const handlers = [];
  const sock = {
    user: { id: '972500000000:1@s.whatsapp.net' },
    ev: { on: (e, f) => handlers.push([e, f]), off: () => log.push('off'), emit: () => log.push('EMIT') },
    end: () => log.push('end'),
    groupMetadata: async (id) => ({ id }),
    fetchMessageHistory: async () => 'asked',
    // everything below must be unreachable through the guard
    sendMessage: async () => log.push('SENT'),
    readMessages: async () => log.push('READ'),
    sendPresenceUpdate: async () => log.push('PRESENCE'),
    sendReceipt: async () => log.push('RECEIPT'),
    groupParticipantsUpdate: async () => log.push('GROUP'),
    updateBlockStatus: async () => log.push('BLOCK'),
    rejectCall: async () => log.push('REJECT'),
    logout: async () => log.push('LOGOUT'),
    brandNewFutureMethod: () => log.push('FUTURE'),
  };
  return { sock, log, handlers };
}

test('allowed read operations work', async () => {
  const { sock, log, handlers } = fakeSocket();
  const g = readOnly(sock);
  assert.strictEqual(g.user.id, sock.user.id);
  g.ev.on('messages.upsert', () => {});
  assert.strictEqual(handlers.length, 1);
  assert.deepStrictEqual(await g.groupMetadata('x@g.us'), { id: 'x@g.us' });
  assert.strictEqual(await g.fetchMessageHistory(), 'asked');
  g.end();
  assert.ok(log.includes('end'));
});

test('every send/act method is blocked, including unknown future ones', () => {
  const { sock, log } = fakeSocket();
  const g = readOnly(sock);
  for (const name of ['sendMessage', 'readMessages', 'sendPresenceUpdate', 'sendReceipt', 'groupParticipantsUpdate',
    'updateBlockStatus', 'rejectCall', 'logout', 'brandNewFutureMethod', 'relayMessage', 'query']) {
    assert.throws(() => g[name], ReadOnlyViolation, name);
  }
  assert.deepStrictEqual(log, [], 'nothing may have been executed');
});

test('events can be listened to but not emitted', () => {
  const { sock, log } = fakeSocket();
  const g = readOnly(sock);
  assert.strictEqual(g.ev.emit, undefined);
  assert.throws(() => g.ev.emit('x'), TypeError);
  assert.throws(() => { g.ev.on = () => {}; }, TypeError); // frozen
  assert.ok(!log.includes('EMIT'));
});

test('the wrapper cannot be modified or replaced', () => {
  const g = readOnly(fakeSocket().sock);
  assert.throws(() => { g.sendMessage = () => {}; }, ReadOnlyViolation);
  assert.throws(() => { delete g.user; }, ReadOnlyViolation);
  assert.throws(() => Object.defineProperty(g, 'x', { value: 1 }), ReadOnlyViolation);
});

test('awaiting or serialising the wrapper does not throw', async () => {
  const g = readOnly(fakeSocket().sock);
  assert.strictEqual(await g, g);
  assert.doesNotThrow(() => JSON.stringify(g));
  assert.doesNotThrow(() => String(Object.prototype.toString.call(g)));
});
