// Asks the running Claude Desktop (Powertoys) to do something a page action does, and prints the outcome.
//
// Usage: node scripts/powertoys-command.mjs <command> [--session <local_…>] [--profile <name>]
//   addTaskList   give a session the app's task list from its next message (as a tab's menu does)
//
// The session defaults to this one (CLAUDE_CODE_HOST_SESSION_ID). Main process: main/powertoys/0350-powertoys-restart.js.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const command = args[0];
if (!command || command.startsWith('--')) {
  console.error('Usage: node scripts/powertoys-command.mjs <command> [--session <local_…>] [--profile <name>]');
  process.exit(2);
}
const sessionId = option('session') ?? process.env.CLAUDE_CODE_HOST_SESSION_ID ?? null;
const profile = option('profile');
const dir = path.join(process.env.APPDATA, profile ? `Claude-${profile}` : 'Claude', 'powertoys');
const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const resultFile = path.join(dir, 'command-result.json');
fs.writeFileSync(path.join(dir, 'command-request.json'), JSON.stringify({ id, command, sessionId }, null, 2));
for (let waited = 0; waited < 20000; waited += 250) {
  try {
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (result.id === id) {
      console.log(result.ok ? `${command}: ${JSON.stringify(result.result)}` : `${command} failed: ${result.error}`);
      process.exit(result.ok ? 0 : 1);
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.error('No answer within 20 s: is Claude Desktop running (with this build)?');
process.exit(1);
