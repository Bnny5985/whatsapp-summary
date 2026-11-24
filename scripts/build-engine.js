// Collects exactly what the installed app needs to run the engine into build/engine:
// the engine's own files, the read-only WhatsApp layer (wa/), and a lean node_modules without the old
// browser-based engine (open-wa + Chrome downloader are ~270 MB and are not used by the app).
//   node scripts/build-engine.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'engine');

const ENGINE_FILES = [
  'index.js', 'web.js', 'db.js', 'paths.js', 'appsettings.js', 'blocks.js', 'budget.js', 'calendar.js', 'events.js',
  'care.js', 'feeding.js', 'links.js', 'localai.js', 'memory.js', 'p2p.js', 'providers.js', 'remote.js', 'router.js', 'telegram.js', 'ui.html',
];
const WA_FILES = ['archive.js', 'compat.js', 'index.js', 'ingest.js', 'normalize.js', 'readonly.js', 'source.js', 'package.json', 'package-lock.json'];
const NOT_SHIPPED = []; // dev-only packages that must not go into the installer

const run = (cmd, cwd) => { console.log(`> ${cmd}   (${path.relative(ROOT, cwd) || '.'})`); execSync(cmd, { cwd, stdio: 'inherit' }); };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'wa'), { recursive: true });
for (const f of ENGINE_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
for (const f of WA_FILES) fs.copyFileSync(path.join(ROOT, 'wa', f), path.join(OUT, 'wa', f));
fs.cpSync(path.join(ROOT, 'public'), path.join(OUT, 'public'), { recursive: true });

// The phone bridge (Rust, p2p-bridge/): a ready binary for this system next to the engine (p2p.js looks for it there).
// Windows: p2p-bridge.exe, macOS: p2p-bridge. P2P_BRIDGE_EXE points at a prebuilt one (e.g. from the GitHub Actions
// build); otherwise it is built here when missing. BUILD_ARCH (x64 | arm64) picks a cross-built macOS binary.
const IS_WIN = process.platform === 'win32';
const BRIDGE_NAME = IS_WIN ? 'p2p-bridge.exe' : 'p2p-bridge';
const BRIDGE_DIR = path.join(ROOT, 'p2p-bridge');
const ARCH = process.env.BUILD_ARCH || process.arch;
const RUST_TARGET = IS_WIN ? 'x86_64-pc-windows-msvc' : process.platform === 'darwin' ? `${ARCH === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : null;
const bridgeCandidates = () => [
  process.env.P2P_BRIDGE_EXE,
  RUST_TARGET && path.join(BRIDGE_DIR, 'target', RUST_TARGET, 'release', BRIDGE_NAME),
  ARCH === process.arch && path.join(BRIDGE_DIR, 'target', 'release', BRIDGE_NAME),
].filter((p) => p && fs.existsSync(p));
if (!bridgeCandidates().length && ['win32', 'darwin'].includes(process.platform)) {
  run(ARCH === process.arch ? 'npm run build:p2p' : `npm run build:p2p -- --target ${RUST_TARGET}`, ROOT);
}
const bridgeExe = bridgeCandidates()[0];
if (!bridgeExe) throw new Error(`${BRIDGE_NAME} is missing: run "npm run build:p2p", or set P2P_BRIDGE_EXE to a prebuilt one (GitHub Actions artifact)`);
fs.copyFileSync(bridgeExe, path.join(OUT, BRIDGE_NAME));
if (!IS_WIN) fs.chmodSync(path.join(OUT, BRIDGE_NAME), 0o755);
console.log(`${BRIDGE_NAME}: ${path.relative(ROOT, bridgeExe)}`);

// Every engine file must be in the list above: a forgotten one would only fail on the user's computer.
for (const f of ENGINE_FILES.filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/require\('\.\/([\w./-]+)'\)/g)) {
    const dep = m[1].endsWith('.js') ? m[1] : `${m[1]}.js`;
    if (!fs.existsSync(path.join(OUT, dep))) throw new Error(`${f} needs ./${dep}, which is not packaged`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dependencies = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => !NOT_SHIPPED.includes(name)));
fs.writeFileSync(path.join(OUT, 'package.json'), `${JSON.stringify({
  name: 'whatsapp-summary-engine', version: pkg.version, private: true, main: 'index.js', type: 'commonjs',
  dependencies,
  allowScripts: Object.fromEntries(Object.entries(pkg.allowScripts || {}).filter(([k]) => k.startsWith('sqlite3@'))),
}, null, 2)}\n`);

run('npm install --omit=dev --no-audit --no-fund', OUT);
run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', path.join(OUT, 'wa')); // Baileys: exact pinned version, no install scripts

// The database driver is native code: make sure the ready-made binary for this system really arrived.
const nodeFiles = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.node')) nodeFiles.push(p); } };
walk(path.join(OUT, 'node_modules', 'sqlite3'));
if (!nodeFiles.length) throw new Error('sqlite3 native binary is missing from build/engine');
// macOS: a binary for the wrong processor would only fail on the user's Mac (each arch is built on its own machine).
if (process.platform === 'darwin') {
  const want = ARCH === 'arm64' ? 'arm64' : 'x86_64';
  for (const f of [...nodeFiles, path.join(OUT, BRIDGE_NAME)]) {
    const archs = execSync(`lipo -archs "${f}"`).toString().trim().split(/\s+/);
    if (!archs.includes(want)) throw new Error(`${path.relative(OUT, f)} is built for ${archs.join(', ')}, not ${want}`);
  }
}

const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`\nbuild/engine ready: ${(size(OUT) / 1e6).toFixed(0)} MB, sqlite3 binary: ${path.relative(OUT, nodeFiles[0])}`);
