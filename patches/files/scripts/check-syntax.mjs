// Checks that the built bundles in <dir>/build/*.js compile (like `node --check`, in one process).
// Usage: node scripts/check-syntax.mjs <dir>   (exit 1 and the first error per file on failure)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const dir = path.join(path.resolve(process.argv[2] ?? 'app/.vite'), 'build');
let failed = 0;
for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.js'))) {
  const file = path.join(dir, name);
  try {
    // The CommonJS wrapper, so top-level return and the module variables compile as under require().
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(file, 'utf8')}\n})`, { filename: file });
  } catch (caught) {
    failed++;
    console.error(`${name}: ${caught.message}`);
  }
}
console.log(failed ? `${failed} file(s) do not compile` : 'all bundles compile');
process.exit(failed ? 1 : 0);
