// Phone requests relayed by the built-in bridge (p2p.js): who gets in, and what they may change.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.WEB_PORT = String(39500 + Math.floor(Math.random() * 400));
process.env.WEB_HOST = '127.0.0.1';
delete process.env.P2P_ENABLED; // so startWebServer does not launch a real bridge
const { startWebServer } = require('../web');
const p2p = require('../p2p');

const quiet = () => {};
const PEER = 'ab'.repeat(32);
let server;
test.before(async () => {
  server = startWebServer({ db: { getSetting: async () => null }, log: quiet, logError: quiet });
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
});
test.after(() => server.close());

function call(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: process.env.WEB_PORT, method, path, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${process.env.WEB_PORT}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
}
const bridge = (extra = {}) => ({ 'X-P2P-Proxy-Secret': p2p.sessionSecret(), 'X-Remote-Peer-Id': PEER, ...extra });

test('bridge requests are refused while phone access is off', async () => {
  process.env.P2P_ENABLED = '0';
  assert.strictEqual(await call('GET', '/', bridge()), 403);
});

test('a paired phone through the bridge may open the dashboard', async () => {
  process.env.P2P_ENABLED = '1';
  assert.strictEqual(await call('GET', '/', bridge()), 200);
});

test('a wrong or missing secret is refused, even from 127.0.0.1', async () => {
  process.env.P2P_ENABLED = '1';
  assert.strictEqual(await call('GET', '/', bridge({ 'X-P2P-Proxy-Secret': 'x'.repeat(48) })), 403);
  assert.strictEqual(await call('GET', '/', { 'X-Remote-Peer-Id': PEER }), 403);
  assert.strictEqual(await call('GET', '/', { 'X-P2P-Proxy-Secret': p2p.sessionSecret() }), 403);
  assert.strictEqual(await call('GET', '/', bridge({ 'X-Remote-Peer-Id': 'not-a-node-id' })), 403);
});

test('a phone cannot change computer-only settings', async () => {
  process.env.P2P_ENABLED = '1';
  for (const p of ['/api/settings/ai', '/api/settings/telegram', '/api/settings/cloud/test', '/api/p2p/disable', '/api/p2p/pair', '/api/p2p/revoke', '/api/remote/enable', '/api/wa/pair', '/api/system/restart', '/api/data/clear-archive', '/api/ai/install']) {
    assert.strictEqual(await call('POST', p, bridge()), 403, p);
  }
});

test('the same paths stay open on the computer itself', async () => {
  // /api/p2p/pair/stop answers 400 (bridge not running) rather than 403: the request was allowed in.
  assert.strictEqual(await call('POST', '/api/p2p/pair/stop', { Host: 'localhost' }), 400);
});

test('a phone may still read its own status and use everyday features', async () => {
  process.env.P2P_ENABLED = '1';
  assert.strictEqual(await call('GET', '/api/p2p', bridge()), 200);
});

test('a cross-site POST through the bridge is refused (CSRF)', async () => {
  process.env.P2P_ENABLED = '1';
  assert.strictEqual(await call('POST', '/api/settings/privacy', bridge({ Origin: 'https://evil.example' })), 403);
});

test('QR codes are drawn locally as SVG', () => {
  const svg = p2p.qrSvg(JSON.stringify({ v: 1, nodeId: PEER, token: 'ff'.repeat(16) }));
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
});
