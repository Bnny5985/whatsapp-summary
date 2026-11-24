// Keeps the bot engine running: starts it, restarts it when it exits, stops it on request.
// Pure Node (no Electron imports) so it can be tested on its own.
//
// Exit codes of the engine (same meaning as in the old start script):
//   3  restart requested (watchdog / dashboard)  -> restart quickly
//   4  another copy already owns the port           -> do NOT restart, report "duplicate"
//   anything else (crash)                           -> restart after a growing delay
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const EXIT_RESTART = 3;
const EXIT_DUPLICATE = 4;

class Supervisor extends EventEmitter {
  /**
   * @param {object} o
   * @param {string}   o.command      executable to run
   * @param {string[]} o.args         arguments
   * @param {string}   o.cwd          working directory (the data dir: open-wa keeps its session here)
   * @param {object}   o.env          extra environment variables
   * @param {function} [o.beforeStart] async hook run before every start (e.g. close a stale WhatsApp window)
   * @param {number}   [o.restartDelayMs]  delay after exit code 3 (default 2s)
   * @param {number[]} [o.crashBackoffMs]  delays after crashes (default 10s, 20s, 40s, 60s...)
   * @param {number}   [o.stableAfterMs]   a run this long resets the crash backoff (default 2 min)
   */
  constructor(o) {
    super();
    this.o = {
      restartDelayMs: 2000,
      crashBackoffMs: [10000, 20000, 40000, 60000],
      stableAfterMs: 120000,
      ...o,
    };
    this.child = null;
    this.stopping = false;
    this.timer = null;
    this.crashes = 0;
    this.startedAt = 0;
    this.state = 'stopped'; // stopped | starting | running | waiting | duplicate
  }

  _setState(s) {
    this.state = s;
    this.emit('state', s);
  }

  async start() {
    if (this.child || this.timer) return;
    this.stopping = false;
    this._setState('starting');
    try {
      if (this.o.beforeStart) await this.o.beforeStart();
    } catch (err) {
      this.emit('log', `beforeStart failed: ${err.message}`);
    }
    if (this.stopping) return this._setState('stopped');

    const child = spawn(this.o.command, this.o.args, {
      cwd: this.o.cwd,
      env: { ...process.env, ...this.o.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.startedAt = Date.now();
    this._setState('running');
    child.stdout.on('data', (d) => this.emit('log', d.toString()));
    child.stderr.on('data', (d) => this.emit('log', d.toString()));
    child.on('error', (err) => this.emit('log', `engine failed to start: ${err.message}`));
    child.on('exit', (code, signal) => this._onExit(child, code, signal));
  }

  _onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.emit('exit', code, signal);
    if (this.stopping) return this._setState('stopped');

    if (code === EXIT_DUPLICATE) {
      this.emit('log', 'Another copy of the bot already owns the port - not restarting.');
      return this._setState('duplicate');
    }
    let delay;
    if (code === EXIT_RESTART) {
      this.crashes = 0;
      delay = this.o.restartDelayMs;
    } else {
      if (Date.now() - this.startedAt >= this.o.stableAfterMs) this.crashes = 0;
      const steps = this.o.crashBackoffMs;
      delay = steps[Math.min(this.crashes, steps.length - 1)];
      this.crashes += 1;
    }
    this.emit('log', `Engine exited (code ${code}${signal ? `, ${signal}` : ''}). Restarting in ${Math.round(delay / 1000)}s.`);
    this._setState('waiting');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delay);
  }

  /** Stop the engine and do not restart. Resolves when the process is gone. */
  stop(graceMs = 5000) {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const child = this.child;
    if (!child) {
      this._setState('stopped');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(force);
        resolve();
      };
      child.once('exit', done);
      child.kill();
      // On Windows a plain kill() is already forceful; this is the safety net for a stuck process tree.
      const force = setTimeout(() => {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          else child.kill('SIGKILL'); // macOS: SIGTERM was ignored or the engine is stuck
        } catch { /* ignore */ }
        setTimeout(done, 1500);
      }, graceMs);
    });
  }

  /** Restart now (user pressed "restart" in the tray). */
  async restart() {
    await this.stop();
    this.crashes = 0;
    return this.start();
  }
}

module.exports = { Supervisor, EXIT_RESTART, EXIT_DUPLICATE };
