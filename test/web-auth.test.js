// Who may reach the dashboard: this computer, or the owner's phone relayed by `tailscale serve`.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.WEB_PORT = String(39000 + Math.floor(Math.random() * 500));
process.env.WEB_HOST = '127.0.0.1';
const { startWebServer } = require('../web');

const quiet = () => {};
let server;
test.before(async () => {
  server = startWebServer({ db: { getSetting: async () => null }, log: quiet, logError: quiet });
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
});
test.after(() => server.close());

function call(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: process.env.WEB_PORT, method, path, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
}

test('this computer may open the dashboard', async () => {
  assert.strictEqual(await call('GET', '/', { Host: 'localhost' }), 200);
});

test('a foreign Host is refused (DNS rebinding)', async () => {
  assert.strictEqual(await call('GET', '/', { Host: 'evil.example' }), 403);
});

test('relayed requests are refused while phone access is off', async () => {
  delete process.env.WEB_ALLOWED_TS_USER;
  assert.strictEqual(await call('GET', '/', { Host: 'my-pc.tail1234.ts.net', 'Tailscale-User-Login': 'you@example.com' }), 403);
  // A relayed request that claims to be localhost is still relayed.
  assert.strictEqual(await call('GET', '/', { Host: 'localhost', 'X-Forwarded-For': '100.64.0.9' }), 403);
});

test('only the owner login gets through the relay', async () => {
  process.env.WEB_ALLOWED_TS_USER = 'you@example.com';
  assert.strictEqual(await call('GET', '/', { Host: 'my-pc.tail1234.ts.net', 'Tailscale-User-Login': 'You@Example.com' }), 200);
  assert.strictEqual(await call('GET', '/', { Host: 'my-pc.tail1234.ts.net', 'Tailscale-User-Login': 'someone@else.com' }), 403);
  assert.strictEqual(await call('GET', '/', { Host: 'my-pc.tail1234.ts.net' }), 403);
  delete process.env.WEB_ALLOWED_TS_USER;
});

test('a relayed owner request with a forged localhost Host cannot change phone access', async () => {
  process.env.WEB_ALLOWED_TS_USER = 'you@example.com';
  const status = await call('POST', '/api/remote/disable', { Host: 'localhost', 'Tailscale-User-Login': 'you@example.com', 'X-Forwarded-For': '100.64.0.9' });
  assert.strictEqual(status, 403);
  delete process.env.WEB_ALLOWED_TS_USER;
});
