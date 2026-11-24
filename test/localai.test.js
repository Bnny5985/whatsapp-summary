const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ai = require('../localai');

const now = Date.parse('2026-11-23T12:00:00Z');
const hw = { ram_gb: 32, vram_gb: 12, gpus: [{ name: 'GPU', vram_gb: 12 }] };
const m = (id, b, created, extra = {}) => ({ id, createdAt: created, downloads: 50000, pipeline_tag: 'text-generation', gguf: { total: b * 1e9, architecture: 'x' }, ...extra });

test('catalog: official models only, one entry per model, newest first, roles by size', () => {
  const lists = {
    unsloth: [m('unsloth/gemma-4-12b-it-GGUF', 12, '2026-10-01'), m('unsloth/Qwen3.5-4B-GGUF', 4.2, '2026-11-01'), m('unsloth/flux-3-image-GGUF', 12, '2026-11-10')],
    bartowski: [m('bartowski/google_gemma-4-12b-it-GGUF', 12, '2026-10-02'), m('bartowski/SomeOne_Roleplay-12B-GGUF', 12, '2026-11-15'), m('bartowski/Qwen_Qwen3.5-9B-GGUF', 9, '2026-09-01')],
    'ggml-org': [m('ggml-org/Qwen3.5-0.8B-DFlash-GGUF', 0.8, '2026-11-12')],
  };
  const c = ai.buildCatalog(lists, { now, hw });
  assert.deepStrictEqual(c.map((x) => x.repo), ['unsloth/Qwen3.5-4B-GGUF', 'unsloth/gemma-4-12b-it-GGUF', 'bartowski/Qwen_Qwen3.5-9B-GGUF']);
  assert.deepStrictEqual(c.map((x) => x.role), ['agent', 'main', 'main']);
  assert.strictEqual(c[1].fit, 'gpu', '12B at Q4 is ~7.6GB + working memory: fits a 12GB card');
  assert.strictEqual(c[2].fit, 'gpu');
});

test('fit: graphics card first, then memory, else too big', () => {
  assert.strictEqual(ai.fitOf(8, hw), 'gpu');
  assert.strictEqual(ai.fitOf(15, hw), 'ram');
  assert.strictEqual(ai.fitOf(40, hw), 'no');
});

test('official names: lab prefix or known family, never community fine-tunes', () => {
  assert.strictEqual(ai.officialName('bartowski/google_gemma-4-31b-it-GGUF'), 'gemma-4-31b-it');
  assert.strictEqual(ai.officialName('bartowski/TheDrummer_Spectre-37B-v1-GGUF'), null);
  assert.strictEqual(ai.officialName('unsloth/Qwen3.8-27B-GGUF'), 'Qwen3.8-27B');
  assert.strictEqual(ai.officialName('bartowski/Qwen_Qwen3-8B-abliterated-GGUF'), null);
});

test('recommendations: the biggest recent Hebrew-friendly model that fits; a small agent', () => {
  const models = ai.buildCatalog({ unsloth: [
    m('unsloth/gemma-4-12b-it-GGUF', 12, '2026-10-01'), m('unsloth/gemma-4-4b-it-GGUF', 4, '2026-10-01'),
    m('unsloth/Qwen3.8-27B-GGUF', 27, '2026-10-01'), m('unsloth/granite-4.2-8b-GGUF', 8, '2026-11-01'),
    m('unsloth/Qwen3.5-4B-GGUF', 4.2, '2026-11-01'), m('unsloth/Qwen3.5-0.8B-GGUF', 0.8, '2026-11-01'),
  ] }, { now, hw: { ram_gb: 64, vram_gb: 24 } });
  const r = ai.rankModels(models, { ram_gb: 64, vram_gb: 24 }, { now });
  assert.strictEqual(r.main[0].repo, 'unsloth/Qwen3.8-27B-GGUF', '27B (~17GB + working memory) fits a 24GB card and is the biggest');
  const small = ai.rankModels(models, { ram_gb: 16, vram_gb: 8 }, { now });
  assert.ok(!small.main.some((x) => x.repo === 'unsloth/Qwen3.8-27B-GGUF'), 'a 27B model is too big for 8GB card + 16GB memory');
  assert.strictEqual(small.main[0].repo, 'unsloth/gemma-4-12b-it-GGUF', 'Hebrew-friendly 12B, partly from memory');
  assert.strictEqual(small.main[0].fit, 'ram');
  assert.strictEqual(r.agent[0].repo, 'unsloth/Qwen3.5-4B-GGUF');
  assert.ok(r.main[0].why.length >= 3);
});

test('file pick: Q4_K_M single file, vision add-on, split files ignored', () => {
  const tree = [
    { type: 'file', path: 'gemma-Q8_0.gguf', size: 13e9, lfs: { oid: 'a' } },
    { type: 'file', path: 'gemma-Q4_K_M.gguf', size: 7e9, lfs: { oid: 'b' } },
    { type: 'file', path: 'BF16/gemma-BF16-00001-of-00002.gguf', size: 12e9 },
    { type: 'file', path: 'mmproj-F32.gguf', size: 9e8 }, { type: 'file', path: 'mmproj-F16.gguf', size: 4e8, lfs: { oid: 'c' } },
    { type: 'file', path: 'README.md', size: 10 },
  ];
  const f = ai.pickFiles(tree);
  assert.strictEqual(f.recommended, 'gemma-Q4_K_M.gguf');
  assert.strictEqual(f.options.length, 2);
  assert.deepStrictEqual(f.mmproj, { path: 'mmproj-F16.gguf', size: 4e8, sha256: 'c' });
});

test('runtime pick: the newest release that has the Windows build asked for, with its checksum', () => {
  const rels = [
    { tag_name: 'v1.0.0', assets: [] },
    { tag_name: 'b12463', assets: [
      { name: 'llama-b12463-bin-win-cpu-x64.zip', browser_download_url: 'u1', size: 1, digest: 'sha256:aa' },
      { name: 'llama-b12463-bin-win-vulkan-x64.zip', browser_download_url: 'u2', size: 2, digest: 'sha256:bb' },
      { name: 'llama-b12463-bin-win-vulkan-arm64.zip', browser_download_url: 'u3', size: 3 }] },
  ];
  assert.deepStrictEqual(ai.pickRuntime(rels, 'vulkan', { platform: 'win32' }), { tag: 'b12463', name: 'llama-b12463-bin-win-vulkan-x64.zip', url: 'u2', size: 2, sha256: 'bb' });
  assert.strictEqual(ai.pickRuntime(rels, 'cuda', { platform: 'win32' }), null);
});

test('runtime pick on macOS: the macos-<arch> tar.gz for both variants, nothing for other systems', () => {
  const rels = [{ tag_name: 'b12675', assets: [
    { name: 'llama-b12675-bin-win-vulkan-x64.zip', browser_download_url: 'w', size: 1 },
    { name: 'llama-b12675-bin-macos-arm64.tar.gz', browser_download_url: 'm1', size: 16, digest: 'sha256:cc' },
    { name: 'llama-b12675-bin-macos-x64.tar.gz', browser_download_url: 'm2', size: 12, digest: 'sha256:dd' },
    { name: 'llama-b12675-xcframework.zip', browser_download_url: 'x', size: 70 }] }];
  const mac = { platform: 'darwin', arch: 'arm64' };
  assert.deepStrictEqual(ai.pickRuntime(rels, 'vulkan', mac), { tag: 'b12675', name: 'llama-b12675-bin-macos-arm64.tar.gz', url: 'm1', size: 16, sha256: 'cc' });
  assert.strictEqual(ai.pickRuntime(rels, 'cpu', mac).url, 'm1');
  assert.strictEqual(ai.pickRuntime(rels, 'cpu', { platform: 'darwin', arch: 'x64' }).url, 'm2');
  assert.strictEqual(ai.pickRuntime(rels, 'cuda', mac), null);
  assert.strictEqual(ai.pickRuntime(rels, 'vulkan', { platform: 'linux', arch: 'x64' }), null);
  assert.strictEqual(ai.pickRuntime(rels, 'vulkan', { platform: 'win32', arch: 'x64' }).url, 'w');
});

test('applyEnv points the engine at the built-in servers only when chosen and the model file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-'));
  fs.mkdirSync(path.join(dir, 'models'));
  fs.writeFileSync(path.join(dir, 'models', 'main.gguf'), 'x');
  ai.writeState(dir, { main: 'main.gguf', agent: 'missing.gguf' });
  const off = { LLM_MODEL: 'lm' };
  assert.deepStrictEqual(ai.applyEnv(off, dir), { active: false });
  assert.strictEqual(off.LLM_MODEL, 'lm');
  const env = { LOCAL_ENGINE: 'builtin', FAST_MODEL: 'old-small', LOCAL_CONTEXT: '16384' };
  assert.deepStrictEqual(ai.applyEnv(env, dir), { active: true, main: true, agent: false });
  assert.strictEqual(env.LLM_BASE_URL, `http://127.0.0.1:${ai.PORTS.main}/v1`);
  assert.strictEqual(env.LLM_CONTEXT_TOKENS, '16384');
  assert.strictEqual(env.FAST_MODEL, '', 'no agent model downloaded: everything goes to the main model');
});

test('download: resumes a partial file and rejects a corrupted one', async () => {
  const body = crypto.randomBytes(200000);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  let ranges = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/models/o/m/tree/main?recursive=true') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ type: 'file', path: 'm-Q4_K_M.gguf', size: body.length, lfs: { oid: req.headers['x-bad'] ? 'f'.repeat(64) : sha } }]));
    }
    const r = /bytes=(\d+)-/.exec(req.headers.range || '');
    ranges.push(r ? Number(r[1]) : 0);
    if (r) { res.writeHead(206); return res.end(body.subarray(Number(r[1]))); }
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let bad = false;
  const fetchImpl = (url, opts = {}) => fetch(url.replace('https://huggingface.co', base), { ...opts, headers: { ...(opts.headers || {}), ...(bad ? { 'x-bad': '1' } : {}) } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-'));
  const inst = ai.createLocalAI({ dir, fetchImpl, platform: 'linux' }); // no llama.cpp build for "linux": no runtime download here
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'o__m__m-Q4_K_M.gguf.part'), body.subarray(0, 50000)); // an earlier, interrupted download
  const job = await inst.downloadModel({ repo: 'o/m', role: 'agent' });
  for (let i = 0; i < 100 && !['done', 'error'].includes(inst.status().jobs[0].state); i++) await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(inst.status().jobs.find((j) => j.id === job.id).state, 'done');
  assert.deepStrictEqual(ranges, [50000], 'continued from where it stopped');
  assert.ok(fs.readFileSync(path.join(dir, 'models', 'o__m__m-Q4_K_M.gguf')).equals(body));
  assert.strictEqual(inst.installed()[0].active_agent, true, 'the first agent model becomes the active one');

  bad = true; ranges = [];
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-'));
  const inst2 = ai.createLocalAI({ dir: dir2, fetchImpl, platform: 'linux' });
  const job2 = await inst2.downloadModel({ repo: 'o/m', role: 'main' });
  for (let i = 0; i < 100 && !['done', 'error'].includes(inst2.status().jobs[0].state); i++) await new Promise((r) => setTimeout(r, 30));
  const j2 = inst2.status().jobs.find((j) => j.id === job2.id);
  assert.strictEqual(j2.state, 'error');
  assert.match(j2.error, /SHA-256/);
  assert.strictEqual(fs.existsSync(path.join(dir2, 'models', 'o__m__m-Q4_K_M.gguf')), false);
  server.close();
});

test('a download survives an engine restart, and a single model download brings llama.cpp along', async () => {
  const body = crypto.randomBytes(120000);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  // A tiny stand-in for the llama.cpp macOS release: llama-<tag>/llama-server inside a .tar.gz.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-tar-'));
  fs.mkdirSync(path.join(tmp, 'llama-b1'));
  fs.writeFileSync(path.join(tmp, 'llama-b1', 'llama-server'), '#!/bin/sh\n');
  require('child_process').execFileSync('tar', ['-czf', path.join(tmp, 'rt.tar.gz'), '-C', tmp, 'llama-b1']);
  const tarball = fs.readFileSync(path.join(tmp, 'rt.tar.gz'));
  const tarSha = crypto.createHash('sha256').update(tarball).digest('hex');
  let ranges = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/repos/ggml-org/llama.cpp/releases')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ tag_name: 'b1', assets: [{ name: 'llama-b1-bin-macos-arm64.tar.gz', browser_download_url: 'https://github.com/rt.tar.gz', size: tarball.length, digest: `sha256:${tarSha}` }] }]));
    }
    if (req.url === '/rt.tar.gz') return res.end(tarball);
    if (req.url === '/api/models/o/m/tree/main?recursive=true') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ type: 'file', path: 'm-Q4_K_M.gguf', size: body.length, lfs: { oid: sha } }]));
    }
    const r = /bytes=(\d+)-/.exec(req.headers.range || '');
    ranges.push(r ? Number(r[1]) : 0);
    if (r) { res.writeHead(206); return res.end(body.subarray(Number(r[1]))); }
    setTimeout(() => res.end(body), 300); // slow enough that a second request arrives while it runs
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, opts) => fetch(url.replace(/^https:\/\/(huggingface\.co|api\.github\.com|github\.com)/, base), opts);
  const mac = { platform: 'darwin', arch: 'arm64' };
  const settle = async (inst) => { for (let i = 0; i < 200 && inst.status().jobs.some((j) => ['downloading', 'verifying', 'installing'].includes(j.state)); i++) await new Promise((r) => setTimeout(r, 30)); };
  const local = 'o__m__m-Q4_K_M.gguf';

  // 1. One model download, nothing else installed: the engine comes too, and nothing is left pending afterwards.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-'));
  const inst = ai.createLocalAI({ dir, fetchImpl, ...mac });
  await inst.downloadModel({ repo: 'o/m', role: 'main' });
  assert.ok(ai.readState(dir).pending_downloads[local], 'remembered while it runs');
  await new Promise((r) => setTimeout(r, 100));
  await settle(inst);
  assert.deepStrictEqual(inst.status().jobs.map((j) => [j.kind, j.state]).sort(), [['model', 'done'], ['runtime', 'done']]);
  assert.strictEqual(inst.runtimeStatus().find((r) => r.variant === 'vulkan').installed, true);
  assert.deepStrictEqual(ai.readState(dir).pending_downloads, {});

  // 2. The engine restarted in the middle: the next start continues from the .part file by itself.
  ranges = [];
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-'));
  fs.mkdirSync(path.join(dir2, 'models'));
  fs.writeFileSync(path.join(dir2, 'models', `${local}.part`), body.subarray(0, 30000));
  ai.writeState(dir2, { pending_downloads: { [local]: { repo: 'o/m', file: 'm-Q4_K_M.gguf', role: 'agent' } } });
  const inst2 = ai.createLocalAI({ dir: dir2, fetchImpl, ...mac });
  await inst2.resumePending();
  await settle(inst2);
  assert.deepStrictEqual(ranges, [30000], 'continued from where it stopped');
  assert.ok(fs.readFileSync(path.join(dir2, 'models', local)).equals(body));
  assert.strictEqual(inst2.installed()[0].active_agent, true);
  assert.deepStrictEqual(ai.readState(dir2).pending_downloads, {});

  // 3. Asking again for a model that is already downloading follows the same job instead of failing.
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-'));
  const inst3 = ai.createLocalAI({ dir: dir3, fetchImpl, platform: 'linux' });
  const a = await inst3.downloadModel({ repo: 'o/m', role: 'main' });
  const b = await inst3.downloadModel({ repo: 'o/m', role: 'main' });
  assert.strictEqual(a.id, b.id);
  await settle(inst3);
  server.close();
});
