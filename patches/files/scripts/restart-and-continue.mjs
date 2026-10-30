// Asks the running Claude Desktop (this build) to rebuild itself, restart, and then send a
// message to a conversation so it carries on. Run it from inside a Code session to continue that
// session: Claude Desktop gives every session its id in CLAUDE_CODE_HOST_SESSION_ID.
//
// Usage: node scripts/restart-and-continue.mjs [--session <local_…>] [--message "<text>"]
//                                              [--no-rebuild] [--ask] [--profile <name>] [--update <git ref>]
//
// --update <ref>: fast-forward the checkout to <ref> and run the full build once the app has quit (a
// release that changes Electron, native add-ons or vendor/); a failed step or start goes back.
//
// Other conversations still working do not stop the restart (they are continued afterwards); --ask
// makes the app ask first, as its menu's restart does.
//
// The app removes the request file as soon as it takes it; a failed rebuild does not restart the app
// and is sent to the conversation instead. Main process: main/powertoys/0350-powertoys-restart.js.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const sessionId = option('session') ?? process.env.CLAUDE_CODE_HOST_SESSION_ID ?? null;
const message = option('message') ?? '';
const rebuild = !args.includes('--no-rebuild');
const update = option('update') ?? null;
const ask = args.includes('--ask');
const profile = option('profile');

const appData = process.env.APPDATA;
if (!appData) {
  console.error('APPDATA is not set');
  process.exit(1);
}
const dir = path.join(appData, profile ? `Claude-${profile}` : 'Claude', 'powertoys');
const file = path.join(dir, 'restart-request.json');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ sessionId, message, rebuild, ask, update, at: Date.now() }, null, 2));
console.log(`Asked Claude Desktop to ${rebuild ? 'rebuild, ' : ''}restart${sessionId ? ` and continue ${sessionId}` : ''}.`);

// Wait (up to 10 s) for the app to take the request, so a closed app is reported.
for (let waited = 0; waited < 10000; waited += 250) {
  if (!fs.existsSync(file)) {
    console.log(rebuild ? 'Request taken: rebuilding now; the app restarts if the build succeeds.' : 'Request taken: restarting now.');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
fs.rmSync(file, { force: true });
console.error('Claude Desktop did not take the request (is this build running with Powertoys?).');
process.exit(2);
