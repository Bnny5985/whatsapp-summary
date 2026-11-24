// The "download the phone app" QR code (p2p.appDownload): newest release with an .apk, or the releases page offline.
const test = require('node:test');
const assert = require('node:assert');

test('app download: the newest release that has an .apk, else the releases page', async () => {
  const p2p = require('../p2p');
  const releases = [
    { tag_name: 'v0.4.0', draft: true, assets: [{ name: 'x.apk', browser_download_url: 'https://github.com/o/r/draft.apk' }] },
    { tag_name: 'v0.3.1', assets: [{ name: 'WhatsApp-Summary-Setup-0.3.1.exe', browser_download_url: 'https://github.com/o/r/s.exe' }] },
    { tag_name: 'v0.3.0', prerelease: true, assets: [{ name: 'WhatsApp-Summary-0.3.0.apk', browser_download_url: 'https://github.com/o/r/a.apk' }] },
  ];
  const offline = await p2p.appDownload({ fetchImpl: async () => { throw new Error('offline'); }, now: 1 });
  assert.strictEqual(offline.url, 'https://github.com/Bnny5985/whatsapp-summary/releases');
  assert.strictEqual(offline.direct, false);
  assert.match(offline.svg, /^<svg/);
  const found = await p2p.appDownload({ fetchImpl: async () => ({ ok: true, json: async () => releases }), now: 2 });
  assert.deepStrictEqual([found.url, found.version, found.direct], ['https://github.com/o/r/a.apk', 'v0.3.0', true]);
  // Cached: no second request within 6 hours.
  const again = await p2p.appDownload({ fetchImpl: async () => { throw new Error('should not be asked'); }, now: 3 });
  assert.strictEqual(again.url, 'https://github.com/o/r/a.apk');
  assert.match(again.svg, /^<svg/);
});
