// Started (detached) by Claude Desktop's "rebuild, restart and continue" just before it quits: waits
// for the app to exit, swaps the freshly built staging copy into place, then starts the app again.
// The running app is never served changed files, and a quit that is cancelled changes nothing.
//
// Usage: node scripts/swap-and-launch.mjs --wait-pid <pid> --staged <dir> --target <dir>
//          --exe <path> [--args <json array>] [--log <file>] [--continue-file <file>] [--ok-file <file>]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const pid = Number(option('wait-pid'));
const staged = option('staged');
const target = option('target');
const exe = option('exe');
const launchArgs = JSON.parse(option('args') ?? '[]');
const logFile = option('log');
const continueFile = option('continue-file');
const WAIT_LIMIT_MS = Number(process.env.POWERTOYS_WAIT_LIMIT_MS) || 10 * 60 * 1000;
const START_LIMIT_MS = Number(process.env.POWERTOYS_START_LIMIT_MS) || 120 * 1000;
const okFile = option('ok-file');
// Says a restart is under way, for an app start the helper did not make itself: Windows starts the app
// on its own when a notification is pressed while it is down (claude.exe -Embedding), and that start
// takes the single-instance lock, so the helper's own start quits at once.
const pendingFile = okFile && `${okFile}.pending`;

const log = (message) => {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line);
    } catch {}
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (caught) {
    return caught.code === 'EPERM';
  }
};
const retry = async (what, action) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return action();
    } catch (caught) {
      if (attempt >= 30) throw caught;
      log(`${what} failed (${caught.code ?? caught.message}), retrying`);
      await sleep(1000);
    }
  }
};

log(`waiting for pid ${pid} to exit`);
const started = Date.now();
while (alive(pid)) {
  if (Date.now() - started > WAIT_LIMIT_MS) {
    log('the app did not quit within 10 minutes (quit cancelled?); discarding the staged build');
    fs.rmSync(staged, { recursive: true, force: true });
    if (continueFile) fs.rmSync(continueFile, { force: true });
    process.exit(0);
  }
  await sleep(500);
}
// Its helper processes (GPU, renderers, utility) go with it; give them a moment.
await sleep(2500);

const previous = `${target}.previous`;
let swapped = false;
try {
  fs.rmSync(previous, { recursive: true, force: true });
  await retry('moving the current build aside', () => fs.renameSync(target, previous));
  try {
    await retry('moving the new build in', () => fs.renameSync(staged, target));
    swapped = true;
  } catch (caught) {
    log(`could not move the new build in (${caught.message}); putting the old one back`);
    await retry('restoring the old build', () => fs.renameSync(previous, target));
  }
} catch (caught) {
  log(`swap failed: ${caught.message}; starting the build that is in place`);
}

const launch = (extraEnv = {}) => {
  // Electron's own output goes to dist/claude.log, as with scripts/start.mjs; never a reason not to start.
  let out = 'ignore';
  try {
    out = fs.openSync(path.join(path.dirname(exe), '..', 'claude.log'), 'w');
  } catch (caught) {
    log(`no claude.log (${caught.code ?? caught.message})`);
  }
  // This helper runs as Node inside the app's runtime (ELECTRON_RUN_AS_NODE); the app must not.
  const env = { ...process.env, POWERTOYS_RESTARTED: '1', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, launchArgs, { detached: true, stdio: ['ignore', out, out], env });
  child.unref();
  log(`started pid ${child.pid}`);
  return child;
};

log(swapped ? 'new build in place; starting the app' : 'starting the app (old build)');
if (okFile) {
  fs.rmSync(okFile, { force: true });
  fs.writeFileSync(pendingFile, String(Date.now()));
}
// The quit may have waited on a "Quit while working?" answer; the message is fresh as of this start.
if (continueFile && fs.existsSync(continueFile)) {
  try {
    const pending = JSON.parse(fs.readFileSync(continueFile, 'utf8'));
    fs.writeFileSync(continueFile, JSON.stringify({ ...pending, at: Date.now() }, null, 2));
  } catch {}
}
const child = launch();
if (!swapped || !okFile) {
  if (swapped) fs.rmSync(previous, { recursive: true, force: true });
  if (pendingFile) fs.rmSync(pendingFile, { force: true });
  process.exit(0);
}

// Keep the previous build until the new one reports that it started (the app writes okFile once
// Powertoys is up). Without that report in time: stop it, put the previous build back, start that.
// A start that quits is waited on a while longer: another start may hold the lock and report instead.
let exited = false;
child.on('exit', () => (exited = true));
const launchedAt = Date.now();
while (Date.now() - launchedAt < START_LIMIT_MS) {
  if (fs.existsSync(okFile)) {
    log('the new build started; removing the previous one');
    fs.rmSync(previous, { recursive: true, force: true });
    fs.rmSync(pendingFile, { force: true });
    process.exit(0);
  }
  if (exited && Date.now() - launchedAt > 30000) break;
  await sleep(1000);
}
log(`the new build did not start${exited ? ' (it exited)' : ` within ${START_LIMIT_MS / 1000} s`}; rolling back`);
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
await sleep(3000);
try {
  fs.rmSync(`${target}.failed`, { recursive: true, force: true });
  await retry('moving the failed build aside', () => fs.renameSync(target, `${target}.failed`));
  await retry('restoring the previous build', () => fs.renameSync(previous, target));
  log(`previous build restored (the failed one is in ${target}.failed)`);
} catch (caught) {
  log(`rollback failed: ${caught.message}`);
}
if (continueFile && fs.existsSync(continueFile)) {
  try {
    const pending = JSON.parse(fs.readFileSync(continueFile, 'utf8'));
    pending.message = `The rebuilt Claude Desktop did not start, so the previous build was put back (the failed build is in app/.vite.failed; see ${logFile}). ${pending.message ?? ''}`.trim();
    pending.at = Date.now();
    fs.writeFileSync(continueFile, JSON.stringify(pending, null, 2));
  } catch {}
}
fs.rmSync(pendingFile, { force: true });
launch();
process.exit(0);
