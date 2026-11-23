// Run: node --test app/test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Supervisor } = require('../supervisor');

// A fake engine whose behaviour is chosen by the exit codes listed in a file (one per run).
function fakeEngine(codes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'));
  const countFile = path.join(dir, 'n');
  fs.writeFileSync(countFile, '0');
  const script = path.join(dir, 'engine.js');
  fs.writeFileSync(script, `
    const fs=require('fs');
    const n=Number(fs.readFileSync(${JSON.stringify(countFile)},'utf8'));
    fs.writeFileSync(${JSON.stringify(countFile)}, String(n+1));
    const codes=${JSON.stringify(codes)};
    if (n >= codes.length) { setInterval(()=>{},1000); } else { process.exit(codes[n]); }
  `);
  return { script, countFile, dir };
}

const mk = (script, extra = {}) =>
  new Supervisor({ command: process.execPath, args: [script], cwd: os.tmpdir(), env: {}, restartDelayMs: 50, crashBackoffMs: [50, 100], ...extra });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('restarts after exit code 3 and after a crash, then keeps running', async () => {
  const { script, countFile } = fakeEngine([3, 1]);
  const s = mk(script);
  await s.start();
  await wait(1500);
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), 3);
  assert.strictEqual(s.state, 'running');
  await s.stop();
  assert.strictEqual(s.state, 'stopped');
});

test('exit code 4 (duplicate) is not restarted', async () => {
  const { script, countFile } = fakeEngine([4]);
  const s = mk(script);
  await s.start();
  await wait(600);
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), 1);
  assert.strictEqual(s.state, 'duplicate');
});

test('stop() prevents any restart', async () => {
  const { script, countFile } = fakeEngine([]);
  const s = mk(script);
  await s.start();
  await wait(300);
  await s.stop();
  await wait(400);
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), 1);
  assert.strictEqual(s.state, 'stopped');
});

test('beforeStart runs before every start', async () => {
  const { script } = fakeEngine([3]);
  let calls = 0;
  const s = mk(script, { beforeStart: async () => { calls += 1; } });
  await s.start();
  await wait(1000);
  await s.stop();
  assert.strictEqual(calls, 2);
});
