// Safe link reader: fetches ONLY the text of a public web page on the server side.
// Nothing is executed (no browser, no JavaScript), downloads are refused, and private /
// local network addresses are blocked at DNS-lookup time (so a link can't reach your router,
// this computer, or your Tailscale devices).
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const MAX_BYTES = 1.5 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const TEXT_TYPES = /text\/html|application\/xhtml\+xml|text\/plain/i;

function extractUrls(text, max = 3) {
  const found = String(text || '').match(URL_RE) || [];
  const clean = found.map((u) => u.replace(/[)\].,!?;:'"״׳]+$/u, ''));
  return [...new Set(clean)].slice(0, max);
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT, incl. Tailscale 100.x
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

// DNS lookup that refuses private addresses - used by the actual connection, so there is
// no gap between "check" and "connect" for DNS-rebinding tricks.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad) return callback(new Error(`blocked private address ${bad.address}`));
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('bad url'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http/https');
  if (u.username || u.password) throw new Error('credentials in url');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('non-standard port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.ts.net') || host.endsWith('.internal')) throw new Error('local host');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('private address');
  return u;
}

function fetchText(rawUrl, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = checkUrl(rawUrl); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      u,
      {
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WhatsAppSummaryBot/1.0; text-only)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          'Accept-Language': 'he,en;q=0.8',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          const next = new URL(res.headers.location, u).toString();
          return fetchText(next, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const type = String(res.headers['content-type'] || '');
        if (!TEXT_TYPES.test(type)) { res.resume(); return reject(new Error(`not a web page (${type || 'unknown type'})`)); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) { req.destroy(); return; }
          chunks.push(c);
        });
        res.on('close', () => {
          const buf = Buffer.concat(chunks);
          const charset = (type.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
          let text;
          try { text = new TextDecoder(charset.toLowerCase()).decode(buf); } catch { text = buf.toString('utf8'); }
          resolve({ url: u.toString(), type, body: text });
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content).trim() : null;
}

function htmlToInfo(html, isHtml) {
  if (!isHtml) return { title: null, description: null, text: html.replace(/\s+/g, ' ').trim().slice(0, 3000) };
  const title = meta(html, 'og:title') || decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim() || null;
  const description = meta(html, 'og:description') || meta(html, 'description');
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim().slice(0, 3000);
  return { title, description, text };
}

async function readLink(url) {
  const page = await fetchText(url);
  const info = htmlToInfo(page.body, /html/i.test(page.type));
  return { url: page.url, ...info };
}

module.exports = { extractUrls, readLink, isPrivateIp, checkUrl };
