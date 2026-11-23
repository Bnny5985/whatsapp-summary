// Read-only guard for the WhatsApp socket.
//
// The rest of the application never receives the real Baileys socket - only this wrapper. It works as an
// ALLOW-list: anything not named below (sending messages, read receipts, typing/online presence, group edits,
// blocking, rejecting calls, profile changes...) throws ReadOnlyViolation, including methods added by future
// Baileys versions. This is a software guard for OUR code; see test/static.test.js, which also scans the
// source for forbidden calls.

export class ReadOnlyViolation extends Error {
  constructor(name) {
    super(`WhatsApp access is read-only: "${String(name)}" is not allowed`);
    this.name = 'ReadOnlyViolation';
    this.property = String(name);
  }
}

// Properties and methods that only read or control the connection itself.
const ALLOWED = new Set([
  'user',                      // who we are logged in as
  'requestPairingCode',        // linking by phone number instead of QR (login, before we are connected)
  'groupMetadata',             // group name/participants (a query)
  'groupFetchAllParticipating',// list of groups (a query)
  'fetchMessageHistory',       // asks the phone for older messages (a peer request; the user sees nothing)
  'end',                       // close the connection (clean shutdown)
]);

// `then` and friends must be silent, otherwise `await guarded` or JSON.stringify would throw.
const SILENT = new Set(['then', 'toJSON', 'inspect', 'constructor']);

export function readOnly(sock) {
  // Only subscribing to events is allowed - not emitting them.
  const ev = Object.freeze({
    on: (...args) => sock.ev.on(...args),
    off: (...args) => sock.ev.off(...args),
  });

  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop === 'symbol' || SILENT.has(prop)) return undefined;
      if (prop === 'ev') return ev;
      if (!ALLOWED.has(prop)) throw new ReadOnlyViolation(prop);
      const value = sock[prop];
      return typeof value === 'function' ? value.bind(sock) : value;
    },
    has: (_target, prop) => prop === 'ev' || ALLOWED.has(prop),
    set: (_target, prop) => { throw new ReadOnlyViolation(prop); },
    defineProperty: (_target, prop) => { throw new ReadOnlyViolation(prop); },
    deleteProperty: (_target, prop) => { throw new ReadOnlyViolation(prop); },
    getPrototypeOf: () => null,
  });
}
