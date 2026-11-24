// Built-in local AI ("no LM Studio needed").
//
// - Runtime: llama.cpp's llama-server (open source, ggml-org/llama.cpp). Downloaded once from its official GitHub
//   releases (Windows: Vulkan build for computers with a graphics card, CPU build otherwise; macOS: the one macOS build,
//   which uses Metal on Apple Silicon) and checked against the SHA-256 that GitHub publishes for each file.
// - Models: GGUF files from Hugging Face. The list is fetched live from the publishers below, newest first, so new
//   models show up without updating the app. Each file is checked against the SHA-256 Hugging Face publishes.
// - Two roles: the MAIN model (summaries, answers) and a small AGENT model (sorting: "does this message hold a task?",
//   "which lines matter?"). Each runs in its own llama-server on 127.0.0.1 only.
//
// Everything lives in <data folder>/ai. Nothing here sends chat text anywhere: the only network calls are the catalog
// (Hugging Face / GitHub APIs) and the downloads the user starts.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORTS = { main: 8790, agent: 8791 };
const PUBLISHERS = ['unsloth', 'ggml-org', 'lmstudio-community', 'bartowski']; // trusted GGUF publishers, in order of preference
const CATALOG_TTL_MS = 12 * 3600e3;
const AGENT_MAX_B = 4.6;   // up to ~4B parameters = a small "agent" model
const MAIN_MAX_B = 40;     // bigger than this does not run well on a home computer
const QUANT_ORDER = ['Q4_K_M', 'UD-Q4_K_XL', 'Q4_K_XL', 'Q4_K_S', 'IQ4_XS', 'Q4_0', 'Q5_K_M', 'UD-Q5_K_XL', 'Q5_K_S', 'Q6_K', 'Q8_0'];
const SKIP_NAME = /(^|[-_.])(image|flux|tts|audio|embed|embedding|embeddings|rerank|reranker|ocr|guard|coder|code|diffusion|vae|whisper|speech|asr|base|draft|math|video|sd|edit)([-_.]|$)/i;

// Rough RAM a Q4 model needs, per billion parameters (weights) + working memory for the context.
const GB_PER_B = 0.62;
const OVERHEAD_GB = 1.5;

// Model families known to handle Hebrew reasonably for their size.
const HEBREW_GOOD = /^(gemma|qwen|llama-?[345]|mistral|ministral|aya|command|dicta|gpt-oss)/i;
// Only official models from the labs that make them (not the thousands of community fine-tunes that get re-published):
// for "org_model" names (bartowski) the org must be one of these; otherwise the name must start with a known family.
const LABS = /^(google|qwen|meta-llama|mistralai|microsoft|nvidia|ibm-granite|coherelabs|cohereforai|deepseek-ai|allenai|huggingfacetb|dicta-il|liquidai|zai-org|thudm|moonshotai|openai|baidu|tencent|ai21labs|swiss-ai)$/i;
const FAMILIES = /^(gemma|qwen|llama|mistral|ministral|magistral|phi|granite|nemotron|nvidia-nemotron|deepseek|glm|kimi|olmo|smollm|lfm|aya|command|dicta|gpt-oss|ernie|hunyuan|jamba|apertus)/i;
const JUNK = /abliterat|uncensor|roleplay|(^|[-_])rp([-_]|$)|nsfw|erp|humaniz|novel|(^|[-_])mtp([-_]|$)|swe|merge|distill|heretic|imatrix|(^|[-_])cua([-_]|$)|dflash|draft|eagle/i;

/** "bartowski/google_gemma-4-12b-it-GGUF" -> official? and the plain model name. */
function officialName(id) {
  const name = String(id).split('/').pop().replace(/[-_.]?GGUF$/i, '');
  const m = /^([A-Za-z0-9-]+)_(.+)$/.exec(name);
  if (m) return LABS.test(m[1]) && !JUNK.test(m[2]) ? m[2] : null;
  return FAMILIES.test(name) && !JUNK.test(name) ? name : null;
}

/** Called once at engine start, BEFORE the rest of the engine reads its settings: points the engine at the built-in servers. */
function applyEnv(env, dir) {
  if (String(env.LOCAL_ENGINE || '') !== 'builtin') return { active: false };
  const st = readState(dir);
  const out = { active: true, main: false, agent: false };
  if (st.main && fs.existsSync(path.join(dir, 'models', st.main))) {
    const url = `http://127.0.0.1:${PORTS.main}/v1`;
    Object.assign(env, { LLM_BASE_URL: url, LM_STUDIO_URL: url, LLM_MODEL: 'main', EXTRACT_MODEL: 'main', VISION_MODEL: 'main', LLM_API_KEY: 'local' });
    env.LLM_CONTEXT_TOKENS = String(Number(env.LOCAL_CONTEXT) || 8192);
    out.main = true;
  }
  if (st.agent && fs.existsSync(path.join(dir, 'models', st.agent))) {
    Object.assign(env, { FAST_MODEL: 'agent', FAST_BASE_URL: `http://127.0.0.1:${PORTS.agent}/v1` });
    out.agent = true;
  } else if (out.main) {
    env.FAST_MODEL = ''; // no agent model: everything goes to the main model
  }
  return out;
}

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) || {}; } catch { return {}; }
}
function writeState(dir, patch) {
  const st = { ...readState(dir), ...patch };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st, null, 2));
  return st;
}

/** "Qwen3.5-4B-Instruct" -> 4 ; uses the GGUF parameter count when Hugging Face gives it. */
function paramsB(m) {
  const x = /(\d+(?:\.\d+)?)\s*[bB](?![a-z])/.exec(String(m.id).split('/')[1] || '');
  const named = x ? Number(x[1]) : null;
  const total = m.gguf?.total ? m.gguf.total / 1e9 : null;
  // Split uploads sometimes report only their first part: trust the size in the name when the two disagree a lot.
  if (total && named && total < named * 0.5) return named;
  return total || named;
}

/** "unsloth/gemma-4-12b-it-GGUF", "bartowski/google_gemma-4-12b-it-GGUF" -> "gemma-4-12b-it" (one entry per model). */
function baseName(id) {
  return String(id).split('/').pop().replace(/[-_.]?GGUF$/i, '').replace(/^[A-Za-z0-9-]+_(?=.)/, '').toLowerCase();
}

/** Turn the raw Hugging Face listings into the catalog the app shows. Pure function (tested). */
function buildCatalog(lists, { now = Date.now(), hw = null } = {}) {
  const seen = new Map();
  for (const author of PUBLISHERS) {
    for (const m of lists[author] || []) {
      const name = officialName(m.id);
      if (!name || SKIP_NAME.test(name)) continue;
      if (m.pipeline_tag && !['text-generation', 'image-text-to-text', 'any-to-any'].includes(m.pipeline_tag)) continue;
      const b = paramsB(m);
      if (!b || b < 0.3 || b > MAIN_MAX_B) continue;
      const created = Date.parse(m.createdAt || '') || 0;
      const fresh = now - created < 21 * 86400e3;
      if ((m.downloads || 0) < 1500 && !fresh) continue; // little-used repos are often broken uploads
      const key = baseName(m.id);
      if (seen.has(key)) continue; // a preferred publisher already has it
      const est = Math.round((b * GB_PER_B + 0.2) * 10) / 10;
      seen.set(key, {
        repo: m.id, name, author, params_b: Math.round(b * 10) / 10,
        arch: m.gguf?.architecture || null, context: m.gguf?.context_length || null,
        created: created ? new Date(created).toISOString() : null, downloads: m.downloads || 0, likes: m.likes || 0,
        role: b <= AGENT_MAX_B ? 'agent' : 'main', vision: m.pipeline_tag === 'image-text-to-text',
        est_gb: est, hebrew: HEBREW_GOOD.test(name), fit: fitOf(est, hw),
      });
    }
  }
  return [...seen.values()].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

/** Will a model of `gb` gigabytes run here?  gpu = fast, ram = works but slower, no = too big. */
function fitOf(gb, hw) {
  if (!hw) return null;
  const need = gb + OVERHEAD_GB;
  if (hw.vram_gb && need <= hw.vram_gb) return 'gpu';
  if (need <= hw.ram_gb * 0.7) return 'ram';
  return 'no';
}

/** From a repo's file list pick the downloadable quantisations (single files only) and the vision add-on. Pure (tested). */
function pickFiles(tree) {
  const files = tree.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path));
  const quantOf = (p) => QUANT_ORDER.find((q) => new RegExp(`[-_.]${q.replace(/[-]/g, '[-_]')}\\.gguf$`, 'i').test(p)) || null;
  const options = files
    .filter((f) => !/mmproj/i.test(f.path) && !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path))
    .map((f) => ({ path: f.path, size: f.size || f.lfs?.size || 0, sha256: f.lfs?.oid || null, quant: quantOf(f.path) || (/[-_.]([A-Z0-9_]+)\.gguf$/i.exec(f.path)?.[1] || '?').toUpperCase() }))
    .sort((a, b) => a.size - b.size);
  const rank = (o) => { const i = QUANT_ORDER.indexOf(o.quant); return i < 0 ? 99 : i; };
  const recommended = [...options].sort((a, b) => rank(a) - rank(b))[0] || null;
  const mm = files.filter((f) => /mmproj/i.test(f.path));
  const mmRank = (p) => ['F16', 'BF16', 'Q8_0', 'F32'].findIndex((q) => new RegExp(q, 'i').test(p)) + 1 || 9;
  const mmproj = mm.sort((a, b) => mmRank(a.path) - mmRank(b.path))[0];
  return {
    options, recommended: recommended?.path || null,
    mmproj: mmproj ? { path: mmproj.path, size: mmproj.size || mmproj.lfs?.size || 0, sha256: mmproj.lfs?.oid || null } : null,
  };
}

/** Pick the llama.cpp Windows build from a GitHub releases listing. Pure (tested). */
/**
 * The llama.cpp release file for this computer. Windows: "win-<variant>-x64.zip" (variant = vulkan | cpu).
 * macOS: "macos-<arch>.tar.gz" - one build for both variants (Metal on Apple Silicon; "cpu" only turns the GPU off).
 */
function runtimeAssetRe(variant, { platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') return ['vulkan', 'cpu'].includes(variant) && ['arm64', 'x64'].includes(arch) ? new RegExp(`^llama-(b\\d+)-bin-macos-${arch}\\.tar\\.gz$`, 'i') : null;
  if (platform === 'win32') return new RegExp(`^llama-(b\\d+)-bin-win-${variant}-x64\\.zip$`, 'i');
  return null;
}

function pickRuntime(releases, variant, target = {}) {
  const re = runtimeAssetRe(variant, target);
  if (!re) return null;
  for (const r of releases || []) {
    const a = (r.assets || []).find((x) => re.test(x.name));
    if (a) return { tag: r.tag_name, name: a.name, url: a.browser_download_url, size: a.size, sha256: String(a.digest || '').replace(/^sha256:/, '') || null };
  }
  return null;
}

function createLocalAI({ dir, log = () => {}, logError = () => {}, fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch } = {}) {
  const modelsDir = path.join(dir, 'models');
  const runtimeDir = path.join(dir, 'llama');
  const jobs = new Map();      // id -> download job
  const servers = {};          // role -> { proc, port, model, state, error, startedAt }
  let hwCache = null;

  const get = async (url, opts = {}) => {
    const res = await fetchImpl(url, { ...opts, headers: { 'User-Agent': 'whatsapp-summary-desktop', Accept: 'application/json', ...(opts.headers || {}) } });
    if (!res.ok && res.status !== 206) throw Object.assign(new Error(`HTTP ${res.status} (${new URL(url).host})`), { status: res.status });
    return res;
  };

  // ---------- hardware ----------
  async function hardware() {
    if (hwCache) return hwCache;
    const ram_gb = Math.round(os.totalmem() / 2 ** 30);
    let gpus = [];
    if (platform === 'win32') {
      const ps = "$r=@(); Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.DriverDesc) { $r += [pscustomobject]@{name=$p.DriverDesc; vram=[string]$p.'HardwareInformation.qwMemorySize'} } }; $r | ConvertTo-Json -Compress";
      const out = await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, windowsHide: true }, (e, so) => resolve(e ? '' : so)));
      try {
        const list = [].concat(JSON.parse(out || '[]'));
        gpus = list.filter((g) => g?.name && !/basic|remote|virtual|parsec|displaylink/i.test(g.name))
          .map((g) => ({ name: g.name, vram_gb: Math.round((Number(g.vram) || 0) / 2 ** 30) }));
      } catch { /* no GPU info */ }
    } else if (platform === 'darwin' && arch === 'arm64') {
      // Apple Silicon: the graphics part shares the computer's memory; Metal lets a program use about 2/3 of it
      // (3/4 on machines with more than 36GB).
      const chip = (os.cpus()[0]?.model || 'Apple Silicon').trim();
      gpus = [{ name: chip, vram_gb: Math.floor(ram_gb * (ram_gb > 36 ? 0.75 : 0.67)), unified: true }];
    }
    const best = gpus.reduce((m, g) => Math.max(m, g.vram_gb || 0), 0);
    hwCache = { ram_gb, cpu_cores: os.cpus().length, gpus, vram_gb: best, suggested_gpu: best >= 2 ? 'vulkan' : 'cpu', platform, accel: platform === 'darwin' ? 'Metal' : 'Vulkan' };
    return hwCache;
  }

  // ---------- catalog ----------
  const catalogFile = path.join(dir, 'catalog.json');
  async function catalog({ refresh = false } = {}) {
    const hw = await hardware().catch(() => null);
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(catalogFile, 'utf8')); } catch { /* none yet */ }
    if (cached && !refresh && Date.now() - Date.parse(cached.fetched_at) < CATALOG_TTL_MS) {
      return { ...cached, models: buildCatalog(cached.raw, { hw }), raw: undefined, from_cache: true };
    }
    const raw = {};
    const errors = [];
    await Promise.all(PUBLISHERS.map(async (author) => {
      const q = `author=${author}&filter=gguf&sort=createdAt&direction=-1&limit=80&expand[]=gguf&expand[]=createdAt&expand[]=downloads&expand[]=likes&expand[]=pipeline_tag`;
      try {
        const list = await (await get(`https://huggingface.co/api/models?${q}`)).json();
        // keep only what the catalog needs (the GGUF chat templates are large)
        raw[author] = list.map((m) => ({ id: m.id, createdAt: m.createdAt, downloads: m.downloads, likes: m.likes, pipeline_tag: m.pipeline_tag, gguf: m.gguf ? { total: m.gguf.total, architecture: m.gguf.architecture, context_length: m.gguf.context_length } : null }));
      } catch (e) { errors.push(`${author}: ${e.message}`); if (cached?.raw?.[author]) raw[author] = cached.raw[author]; }
    }));
    if (!Object.keys(raw).length) {
      if (cached) return { ...cached, models: buildCatalog(cached.raw, { hw }), raw: undefined, from_cache: true, error: errors.join('; ') };
      throw new Error(`אין חיבור לקטלוג המודלים (${errors.join('; ')})`);
    }
    const saved = { fetched_at: new Date().toISOString(), raw };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(catalogFile, JSON.stringify(saved));
    return { fetched_at: saved.fetched_at, models: buildCatalog(raw, { hw }), from_cache: false, error: errors.length ? errors.join('; ') : null };
  }

  async function files(repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('bad repo');
    const tree = await (await get(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`)).json();
    return pickFiles(Array.isArray(tree) ? tree : []);
  }

  // ---------- downloads ----------
  /** Download url -> dest with resume (.part), progress, and a SHA-256 check. */
  async function downloadFile(job, url, dest, sha256, size) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size && have > size) { fs.rmSync(part); have = 0; }
    job.done = have;
    if (!size || have < size) {
      const res = await get(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: job.abort.signal });
      if (have && res.status !== 206) have = 0; // server ignored the range: start over
      if (!job.total) job.total = size || (have + Number(res.headers.get('content-length') || 0));
      job.done = have;
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          job.done += chunk.length;
        }
      } finally { await new Promise((r) => out.end(r)); }
    }
    if (sha256) {
      job.state = 'verifying';
      const hash = crypto.createHash('sha256');
      for await (const c of fs.createReadStream(part)) hash.update(c);
      if (hash.digest('hex') !== sha256.toLowerCase()) { fs.rmSync(part, { force: true }); throw new Error('הקובץ שהתקבל פגום (בדיקת SHA-256 נכשלה). נסה שוב.'); }
    }
    fs.renameSync(part, dest);
  }

  function newJob(kind, label, total) {
    const id = crypto.randomBytes(5).toString('hex');
    const job = { id, kind, label, state: 'downloading', done: 0, total: total || 0, error: null, started: Date.now(), abort: new AbortController() };
    jobs.set(id, job);
    return job;
  }
  const publicJob = (j) => ({ id: j.id, kind: j.kind, label: j.label, state: j.state, done: j.done, total: j.total, error: j.error, role: j.role, file: j.file });

  // Downloads in progress are remembered in state.json, so an engine restart (saving settings, the restart button,
  // a crash) does not lose them: resumePending() continues them from their .part files when the engine starts again.
  const pendingDownloads = () => readState(dir).pending_downloads || {};
  const rememberDownload = (local, entry) => writeState(dir, { pending_downloads: { ...pendingDownloads(), [local]: entry } });
  const forgetDownload = (local) => { const p = { ...pendingDownloads() }; delete p[local]; writeState(dir, { pending_downloads: p }); };

  /** The llama.cpp build this computer uses, downloaded too when it is missing (a model is no use without it). */
  async function ensureRuntime() {
    const v = (await hardware()).suggested_gpu;
    if (runtimeExe(v) || !runtimeAssetRe(v, { platform, arch })) return null;
    return installRuntime(v);
  }

  /** Start downloading a model (and its vision add-on when there is one). Returns the job at once. */
  async function downloadModel({ repo, file, role }) {
    const info = await files(repo);
    const pick = info.options.find((o) => o.path === (file || info.recommended));
    if (!pick) throw new Error('לא נמצא קובץ מתאים להורדה במודל הזה');
    const local = `${repo.replace('/', '__')}__${path.basename(pick.path)}`;
    const running = [...jobs.values()].find((j) => j.file === local && ['downloading', 'verifying'].includes(j.state));
    if (running) return publicJob(running); // already on its way (e.g. resumed after a restart): follow that one
    const job = newJob('model', `${repo.split('/')[1]} (${pick.quant})`, pick.size + (info.mmproj?.size || 0));
    Object.assign(job, { role: role === 'agent' ? 'agent' : 'main', file: local });
    rememberDownload(local, { repo, file: pick.path, role: job.role });
    ensureRuntime().catch((e) => logError(`llama.cpp download did not start: ${e.message}`));
    (async () => {
      try {
        await downloadFile(job, `https://huggingface.co/${repo}/resolve/main/${pick.path.split('/').map(encodeURIComponent).join('/')}`, path.join(modelsDir, local), pick.sha256, pick.size);
        let mmLocal = null;
        if (info.mmproj && job.role === 'main') {
          const base = job.done;
          mmLocal = `${local.replace(/\.gguf$/i, '')}.mmproj.gguf`;
          const sub = { ...job, done: 0, total: 0 };
          const tick = setInterval(() => { job.done = base + sub.done; }, 300);
          try { job.state = 'downloading'; await downloadFile(sub, `https://huggingface.co/${repo}/resolve/main/${info.mmproj.path.split('/').map(encodeURIComponent).join('/')}`, path.join(modelsDir, mmLocal), info.mmproj.sha256, info.mmproj.size); }
          catch (e) { mmLocal = null; log(`Vision add-on for ${repo} not downloaded: ${e.message}`); }
          finally { clearInterval(tick); }
        }
        const meta = { repo, file: local, source_path: pick.path, quant: pick.quant, size: pick.size, mmproj: mmLocal, downloaded_at: new Date().toISOString() };
        fs.writeFileSync(path.join(modelsDir, `${local}.json`), JSON.stringify(meta, null, 2));
        job.state = 'done';
        job.done = job.total;
        forgetDownload(local);
        log(`Model downloaded: ${repo} ${pick.quant}`);
        // The first model of each role becomes the active one.
        const st = readState(dir);
        if (!st[job.role]) writeState(dir, { [job.role]: local });
      } catch (e) {
        job.state = e.name === 'AbortError' ? 'cancelled' : 'error';
        job.error = e.name === 'AbortError' ? null : e.message;
        // Cancelled by the user: forget it. A failed one (network) is tried again on the next start.
        if (job.state === 'cancelled') forgetDownload(local);
        if (job.state === 'error') logError(`Model download failed (${repo}): ${e.message}`);
      }
    })();
    return publicJob(job);
  }

  // ---------- recommendations + one-click setup ----------
  /**
   * Scan this computer and pick the models that fit it best: newest, good at Hebrew, and as large as the graphics card
   * holds (bigger = better summaries) for the main model; a small one (2-4B) for the agent. Pure ranking over the catalog.
   */
  async function recommend({ refresh = false } = {}) {
    const hw = await hardware();
    const cat = await catalog({ refresh });
    return { hardware: hw, fetched_at: cat.fetched_at, ...rankModels(cat.models, hw) };
  }

  const waitJob = (job) => new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      const j = jobs.get(job.id);
      if (!j || !['downloading', 'verifying', 'installing'].includes(j.state)) {
        clearInterval(tick);
        if (j?.state === 'done') resolve(j); else reject(new Error(j?.error || 'ההורדה בוטלה'));
      }
    }, 500);
  });

  let setupRun = null;
  /** Download the engine and the chosen models, make them active, then call onReady (the app restarts the engine). */
  function autoSetup({ main, agent, variant, onReady }) {
    if (setupRun?.state === 'running') throw new Error('ההתקנה כבר רצה');
    setupRun = { state: 'running', step: 'מתחיל', error: null };
    writeState(dir, { pending_setup: { main: main || null, agent: agent || null, variant: variant || null } });
    (async () => {
      try {
        const v = variant || (await hardware()).suggested_gpu;
        if (!runtimeExe(v)) { setupRun.step = 'מוריד את מנוע llama.cpp'; await waitJob(await installRuntime(v)); }
        for (const [role, pick] of [['main', main], ['agent', agent]]) {
          if (!pick?.repo) continue;
          setupRun.step = role === 'main' ? 'מוריד את המודל הראשי' : 'מוריד את מודל הסוכן';
          const job = await downloadModel({ repo: pick.repo, file: pick.file, role });
          await waitJob(job);
          setActive(role, job.file);
        }
        writeState(dir, { pending_setup: null });
        setupRun = { state: 'done', step: 'הסתיים', error: null };
        if (onReady) await onReady();
      } catch (e) {
        writeState(dir, { pending_setup: null });
        setupRun = { state: 'error', step: setupRun.step, error: e.message };
        logError(`Local AI setup failed: ${e.message}`);
      }
    })();
    return setupRun;
  }

  // ---------- Hebrew self-test ----------
  /**
   * A short test of a running model on the jobs this app gives it: speed, Hebrew, finding a task, reading a date change,
   * a yes/no sort. Loading on the graphics card says nothing about quality - this does. Results are kept per model file.
   */
  async function benchmark(role) {
    const s = servers[role];
    if (!s || s.state !== 'ready') throw new Error('המודל לא פועל כרגע');
    const ask = async (content, maxTokens = 200) => {
      const t0 = Date.now();
      const r = await fetchImpl(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: role, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return { text: String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(), ms: Date.now() - t0, tokens: j.usage?.completion_tokens || 0 };
    };
    const results = [];
    const run = async (name, fn) => { try { results.push({ name, ...(await fn()) }); } catch (e) { results.push({ name, ok: false, detail: e.message }); } };
    await run('מהירות', async () => {
      const r = await ask('כתוב שלוש פסקאות קצרות בעברית על חשיבות השינה לילדים.', 220);
      const tps = r.tokens && r.ms ? Math.round((r.tokens / r.ms) * 1000) : 0;
      return { ok: tps >= 8, score: tps, detail: `${tps} מילים-חלקיות בשנייה` };
    });
    await run('עברית', async () => {
      const r = await ask('סכם במשפט אחד בעברית: "שלום לכולם, ביום חמישי אין לימודים בגלל אסיפת מורים. הילדים יוצאים ב-12:00 ביום רביעי."', 120);
      const heb = (r.text.match(/[֐-׿]/g) || []).length / Math.max(1, (r.text.match(/\p{L}/gu) || []).length);
      const ok = heb > 0.8 && /חמישי/.test(r.text);
      return { ok, score: Math.round(heb * 100), detail: r.text.slice(0, 140) };
    });
    await run('זיהוי משימה', async () => {
      const r = await ask('הודעה בקבוצה: "בני, אתה יכול להביא שתייה למסיבה ביום שישי?" ובני ענה "בסדר".\nהחזר JSON בלבד: {"task":"מה צריך לעשות","who":"מי","due":"מתי"}', 120);
      const m = /\{[\s\S]*\}/.exec(r.text);
      let j = null; try { j = m && JSON.parse(m[0]); } catch { /* not JSON */ }
      const ok = Boolean(j && /שתי/.test(String(j.task)) && /בני/.test(String(j.who)) && /שישי/.test(String(j.due)));
      return { ok, score: ok ? 100 : 0, detail: r.text.slice(0, 140) };
    });
    await run('שינוי תאריך', async () => {
      const r = await ask('היום יום שני 23/11/2026. בקבוצה נכתב: "האסיפה שהייתה ביום שלישי הועברה ליום רביעי בשבע בערב".\nמה התאריך והשעה החדשים? ענה רק בצורה YYYY-MM-DD HH:MM', 40);
      const ok = /2026-11-25\s+19:00/.test(r.text);
      return { ok, score: ok ? 100 : 0, detail: r.text.slice(0, 80) };
    });
    await run('מיון כן/לא', async () => {
      const a = await ask('האם בהודעה יש אירוע או משימה? ענה במילה אחת: כן או לא.\nההודעה: "מחר ב-17:00 אסיפת הורים בכיתה"', 5);
      const b = await ask('האם בהודעה יש אירוע או משימה? ענה במילה אחת: כן או לא.\nההודעה: "חחח איזה מצחיק 😂"', 5);
      const ok = /^\W*כן/.test(a.text) && /^\W*לא/.test(b.text);
      return { ok, score: ok ? 100 : 0, detail: `${a.text} / ${b.text}` };
    });
    let memory_mb = null;
    if (platform === 'win32' && s.proc?.pid) {
      const out = await new Promise((resolve) => execFile('tasklist', ['/FI', `PID eq ${s.proc.pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 }, (e, so) => resolve(e ? '' : String(so))));
      const m = /"([\d.,\s]+)\s*K"/.exec(out);
      if (m) memory_mb = Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024);
    } else if (s.proc?.pid) {
      const out = await new Promise((resolve) => execFile('ps', ['-o', 'rss=', '-p', String(s.proc.pid)], { timeout: 10000 }, (e, so) => resolve(e ? '' : String(so))));
      if (Number(out.trim())) memory_mb = Math.round(Number(out.trim()) / 1024);
    }
    const passed = results.filter((r) => r.ok).length;
    const verdict = role === 'agent'
      ? (results.find((r) => r.name === 'מיון כן/לא')?.ok && (results[0].score >= 20) ? 'מתאים לתפקיד סוכן' : 'לא מומלץ כסוכן')
      : (passed >= 4 ? 'מתאים למודל ראשי' : passed >= 3 ? 'סביר, אבל יש טובים ממנו' : 'לא מומלץ לסיכומים בעברית');
    const report = { role, model: s.model, repo: s.repo, at: new Date().toISOString(), passed, of: results.length, verdict, memory_mb, results };
    const st = readState(dir);
    writeState(dir, { bench: { ...(st.bench || {}), [s.model]: report } });
    log(`Local ${role} model test: ${passed}/${results.length} (${verdict})`);
    return report;
  }

  function cancel(id) {
    const j = jobs.get(id);
    if (j && ['downloading', 'verifying'].includes(j.state)) j.abort.abort();
    return Boolean(j);
  }

  function installed() {
    let list = [];
    try { list = fs.readdirSync(modelsDir).filter((f) => f.endsWith('.gguf.json')); } catch { return []; }
    const st = readState(dir);
    return list.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(modelsDir, f), 'utf8')); } catch { return null; } })
      .filter((m) => m && fs.existsSync(path.join(modelsDir, m.file)))
      .map((m) => ({ ...m, active_main: st.main === m.file, active_agent: st.agent === m.file }));
  }

  function setActive(role, file) {
    if (!['main', 'agent'].includes(role)) throw new Error('bad role');
    if (file && !installed().some((m) => m.file === file)) throw new Error('המודל לא מותקן');
    return writeState(dir, { [role]: file || null });
  }

  async function removeModel(file) {
    const m = installed().find((x) => x.file === file);
    if (!m) throw new Error('המודל לא מותקן');
    const st = readState(dir);
    for (const role of ['main', 'agent']) if (st[role] === file) { await stopServer(role); writeState(dir, { [role]: null }); }
    for (const f of [m.file, m.mmproj, `${m.file}.json`]) if (f) fs.rmSync(path.join(modelsDir, f), { force: true });
  }

  // ---------- runtime (llama.cpp) ----------
  function runtimeExe(variant) {
    const base = path.join(runtimeDir, variant);
    const find = (d, depth = 0) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
      for (const e of entries) if (e.isFile() && /^llama-server(\.exe)?$/i.test(e.name)) return path.join(d, e.name);
      if (depth < 2) for (const e of entries) if (e.isDirectory()) { const r = find(path.join(d, e.name), depth + 1); if (r) return r; }
      return null;
    };
    return find(base);
  }

  function runtimeStatus() {
    const st = readState(dir);
    return ['vulkan', 'cpu'].map((v) => ({ variant: v, installed: Boolean(runtimeExe(v)), tag: st[`runtime_${v}`] || null }));
  }

  async function installRuntime(variant) {
    if (!['vulkan', 'cpu'].includes(variant)) throw new Error('bad variant');
    if (!runtimeAssetRe(variant, { platform, arch })) throw new Error('ההורדה האוטומטית של המנוע זמינה ב-Windows וב-macOS בלבד');
    const running = [...jobs.values()].find((j) => j.kind === 'runtime' && j.file === variant && ['downloading', 'verifying'].includes(j.state));
    if (running) return publicJob(running);
    const releases = await (await get('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15')).json();
    const rel = pickRuntime(releases, variant, { platform, arch });
    if (!rel) throw new Error(`לא נמצאה גרסת llama.cpp ל-${platform === 'darwin' ? 'macOS' : 'Windows'}`);
    const job = newJob('runtime', `llama.cpp ${rel.tag} (${variant === 'vulkan' ? 'כרטיס מסך' : 'מעבד'})`, rel.size);
    job.file = variant;
    (async () => {
      try {
        const zip = path.join(runtimeDir, `${variant}${platform === 'darwin' ? '.tar.gz' : '.zip'}`);
        await downloadFile(job, rel.url, zip, rel.sha256, rel.size);
        job.state = 'installing';
        const target = path.join(runtimeDir, variant);
        if (servers.main?.variant === variant || servers.agent?.variant === variant) { await stopServer('main'); await stopServer('agent'); }
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target, { recursive: true });
        // Windows 10+ and macOS both ship bsdtar, which reads zip and tar.gz files.
        await new Promise((resolve, reject) => execFile('tar', ['-xf', zip, '-C', target], { windowsHide: true, timeout: 5 * 60e3 }, (e) => (e ? reject(e) : resolve())));
        fs.rmSync(zip, { force: true });
        const exe = runtimeExe(variant);
        if (!exe) throw new Error('llama-server לא נמצא בקובץ שהורד');
        if (platform === 'darwin') {
          fs.chmodSync(exe, 0o755);
          // Nothing here marks the files as "downloaded from the internet", but if something did, macOS would refuse
          // to run the unsigned dylibs: clear the mark (the checksum above already proved the files are GitHub's).
          await new Promise((resolve) => execFile('xattr', ['-dr', 'com.apple.quarantine', target], { timeout: 60e3 }, () => resolve()));
        }
        writeState(dir, { [`runtime_${variant}`]: rel.tag });
        job.state = 'done';
        job.done = job.total;
        log(`llama.cpp ${rel.tag} (${variant}) installed`);
      } catch (e) {
        job.state = e.name === 'AbortError' ? 'cancelled' : 'error';
        job.error = e.name === 'AbortError' ? null : e.message;
        if (job.state === 'error') logError(`llama.cpp install failed: ${e.message}`);
      }
    })();
    return publicJob(job);
  }

  /**
   * Engine start: continue what a restart interrupted - the one-click setup (it ends by switching to the built-in engine,
   * onSetupReady) and every model download, each from its .part file.
   */
  async function resumePending({ onSetupReady } = {}) {
    const st = readState(dir);
    if (st.pending_setup) {
      log('Local AI: continuing the setup that a restart interrupted');
      autoSetup({ ...st.pending_setup, onReady: onSetupReady });
    }
    for (const [local, d] of Object.entries(st.pending_downloads || {})) {
      if (fs.existsSync(path.join(modelsDir, local))) { forgetDownload(local); continue; }
      try { await downloadModel(d); log(`Local AI: continuing the download of ${d.repo}`); }
      catch (e) { logError(`Local AI: could not continue the download of ${d.repo}: ${e.message}`); }
    }
  }

  // ---------- servers ----------
  const helpCache = {};
  async function serverHelp(exe) {
    if (helpCache[exe] !== undefined) return helpCache[exe];
    helpCache[exe] = await new Promise((resolve) => execFile(exe, ['--help'], { windowsHide: true, timeout: 20000, maxBuffer: 4 * 2 ** 20 }, (e, so, se) => resolve(`${so || ''}${se || ''}`)));
    return helpCache[exe];
  }

  async function stopServer(role) {
    const s = servers[role];
    if (!s?.proc) return;
    s.stopping = true;
    try { s.proc.kill(); } catch { /* already gone */ }
    await new Promise((r) => { if (s.proc.exitCode !== null) return r(); s.proc.once('exit', r); setTimeout(r, 5000); });
    delete servers[role];
  }

  // A server left over from an engine that crashed would hold the port: stop it - but only if that process id
  // still belongs to llama-server (Windows reuses process ids).
  async function killStale(role) {
    const pid = Number(readState(dir)[`pid_${role}`]);
    if (!pid) return;
    let name = '';
    if (platform === 'win32') {
      name = await new Promise((resolve) => execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 }, (e, so) => resolve(e ? '' : String(so))));
    } else {
      name = await new Promise((resolve) => execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 10000 }, (e, so) => resolve(e ? '' : String(so))));
    }
    if (!/llama-server/i.test(name)) return;
    try { process.kill(pid); await new Promise((r) => setTimeout(r, 1000)); } catch { /* not running */ }
  }

  async function startServer(role, { variant, context = 8192 } = {}) {
    const st = readState(dir);
    const file = st[role];
    if (!file) return null;
    const model = installed().find((m) => m.file === file);
    if (!model) return null;
    const v = variant || (await hardware()).suggested_gpu;
    const exe = runtimeExe(v) || runtimeExe(v === 'vulkan' ? 'cpu' : 'vulkan');
    if (!exe) { servers[role] = { state: 'no-runtime', model: file }; return servers[role]; }
    await stopServer(role);
    await killStale(role);
    const help = await serverHelp(exe);
    const args = ['-m', path.join(modelsDir, file), '--host', '127.0.0.1', '--port', String(PORTS[role]), '-c', String(role === 'agent' ? Math.min(context, 8192) : context), '--alias', role, '--jinja'];
    const cpuOnly = exe.includes(`${path.sep}cpu${path.sep}`);
    if (platform === 'darwin' && cpuOnly) args.push('-ngl', '0');        // macOS has one build: "cpu" = keep the GPU off
    else if (!/--fit\b/.test(help)) args.push('-ngl', '999');          // older builds: put every layer on the graphics card
    if (/--reasoning-budget\b/.test(help)) args.push('--reasoning-budget', '0'); // no hidden "thinking": answers come straight away
    if (role === 'main' && model.mmproj && fs.existsSync(path.join(modelsDir, model.mmproj))) args.push('--mmproj', path.join(modelsDir, model.mmproj));
    const proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const s = { proc, port: PORTS[role], model: file, repo: model.repo, variant: cpuOnly ? 'cpu' : 'vulkan', state: 'loading', error: null, startedAt: Date.now(), tail: [] };
    servers[role] = s;
    writeState(dir, { [`pid_${role}`]: proc.pid });
    const keep = (d) => { for (const line of String(d).split(/\r?\n/)) if (line.trim()) { s.tail.push(line.slice(0, 300)); if (s.tail.length > 30) s.tail.shift(); } };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    proc.on('exit', (code) => {
      if (servers[role] !== s) return;
      s.state = s.stopping ? 'stopped' : 'crashed';
      if (!s.stopping) { s.error = `llama-server stopped (code ${code}): ${s.tail.slice(-3).join(' | ')}`; logError(`Local ${role} model: ${s.error}`); }
    });
    // Wait until the model is loaded (llama-server answers /health with 200).
    (async () => {
      const deadline = Date.now() + 10 * 60e3;
      while (Date.now() < deadline && servers[role] === s && s.state === 'loading') {
        try { const r = await fetchImpl(`http://127.0.0.1:${s.port}/health`); if (r.ok) { s.state = 'ready'; log(`Local ${role} model ready: ${model.repo} (${s.variant}, port ${s.port})`); break; } } catch { /* still starting */ }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (s.state === 'loading') { s.state = 'crashed'; s.error = 'הטעינה לקחה יותר מדי זמן'; }
    })();
    return s;
  }

  async function startConfigured(env = process.env) {
    if (String(env.LOCAL_ENGINE || '') !== 'builtin') return;
    const variant = ['vulkan', 'cpu'].includes(env.LOCAL_GPU) ? env.LOCAL_GPU : undefined;
    const context = Number(env.LOCAL_CONTEXT) || 8192;
    for (const role of ['main', 'agent']) await startServer(role, { variant, context }).catch((e) => logError(`Local ${role} model did not start: ${e.message}`));
  }

  function stopAll() {
    for (const s of Object.values(servers)) { try { s.stopping = true; s.proc?.kill(); } catch { /* gone */ } }
  }

  function status() {
    const pub = (s) => (s ? { state: s.state, model: s.model, repo: s.repo, variant: s.variant, port: s.port, error: s.error } : { state: 'off' });
    return { servers: { main: pub(servers.main), agent: pub(servers.agent) }, runtime: runtimeStatus(), jobs: [...jobs.values()].map(publicJob), state: readState(dir) };
  }

  return { hardware, catalog, files, recommend, autoSetup, get setup() { return setupRun; }, benchmark, downloadModel, cancel, installed, setActive, removeModel, installRuntime, runtimeStatus, resumePending, startServer, startConfigured, stopServer, stopAll, status, dir };
}

/**
 * Rank catalog models for this computer. Pure (tested).
 * Main: runs on the graphics card, newest generation first (released in the last ~9 months), Hebrew-friendly, and the
 * largest that fits. Agent: small (1.5-4.6B), Hebrew-friendly, newest.
 */
function rankModels(models, hw, { now = Date.now() } = {}) {
  const ageDays = (m) => (now - Date.parse(m.created || 0)) / 86400e3;
  const recent = (m) => ageDays(m) <= 270;
  const score = (m, role) => {
    let s = 0;
    if (m.hebrew) s += 40;
    if (recent(m)) s += 25;
    s -= Math.min(ageDays(m), 720) / 30;               // newer is better
    if (m.fit === 'gpu') s += 30; else if (m.fit === 'ram') s += role === 'agent' ? 10 : -10; else s -= 200;
    if (role === 'main') s += Math.min(m.params_b, 40) * 1.5;  // bigger summarizes better, while it fits
    // Specialists (coding, agents, vision-only, "thinking") suit plain Hebrew summaries and sorting less well.
    if (/agent|coder|swe|math|reason|thinking|omni|-vl|vl-/i.test(m.name)) s -= 25;
    else s += m.params_b >= 1.5 ? 10 : -10;
    s += Math.log10(1 + (m.downloads || 0)) * 2;       // widely used = fewer broken uploads
    return Math.round(s * 10) / 10;
  };
  const pick = (role) => models.map((m) => ({ ...m, fit: hw ? fitOf(m.est_gb, hw) : m.fit })).filter((m) => m.role === role && m.fit !== 'no')
    .map((m) => ({ ...m, score: score(m, role) })).sort((a, b) => b.score - a.score).slice(0, 5);
  const main = pick('main');
  const agent = pick('agent');
  const why = (m, role) => (m ? [
    m.fit === 'gpu' ? `נכנס לכרטיס המסך (${hw?.vram_gb || '?'}GB)` : 'רץ מהזיכרון הרגיל, לאט יותר',
    m.hebrew ? 'משפחת מודלים שמתמודדת טוב עם עברית' : null,
    `פורסם ${m.created ? new Date(m.created).toLocaleDateString('he-IL') : ''}`,
    role === 'main' ? `${m.params_b} מיליארד פרמטרים, כ-${m.est_gb}GB` : `קטן ומהיר (${m.params_b}B) לעבודות מיון`,
  ].filter(Boolean) : []);
  return {
    main: main.map((m, i) => ({ ...m, recommended: i === 0, why: why(m, 'main') })),
    agent: agent.map((m, i) => ({ ...m, recommended: i === 0, why: why(m, 'agent') })),
  };
}

module.exports = { officialName, createLocalAI, applyEnv, buildCatalog, pickFiles, pickRuntime, runtimeAssetRe, rankModels, fitOf, paramsB, readState, writeState, PORTS, PUBLISHERS };
