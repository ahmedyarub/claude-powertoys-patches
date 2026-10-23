// Applies a Powertoys patch package (patches.json + files/) to the Claude Desktop tree it was made for.
//
// Usage: node apply-patches.mjs <package-dir> <tree-dir> [--check]
//
// A package holds no Claude Desktop code. Added files are copied in. An edited file is rebuilt from the tree's own
// copy (new lines are our text plus [line, start, end] ranges of that copy): its SHA-256 must match the package's base (else the file is from another release or already patched and
// nothing is written), each hunk's replaced lines must match their SHA-256, and the result must match the
// package's result SHA-256. --check only reports what would happen. No dependencies: Node 18+.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
function linesOf(buffer) {
  return buffer.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The edited file's bytes from its base bytes and the package entry; throws when the base is not the one expected. */
export function applyEdits(before, entry) {
  if (sha256(before) !== entry.baseSha256) {
    throw Error(`${entry.path}: not the expected base (another release, or already patched)`);
  }
  let original = linesOf(before);
  let lines = [...original];
  // Bottom up, so line numbers above stay valid.
  for (let hunk of [...entry.hunks].sort((left, right) => right.at - left.at)) {
    let replaced = lines.slice(hunk.at, hunk.at + hunk.remove);
    if (hunk.remove && sha256(replaced.join("")) !== hunk.removeSha256) {
      throw Error(`${entry.path}: lines ${hunk.at + 1}-${hunk.at + hunk.remove} are not the expected ones`);
    }
    let added = hunk.add.map((parts) => parts.map((part) => (typeof part === "string" ? part : original[part[0]].slice(part[1], part[2]))).join(""));
    lines.splice(hunk.at, hunk.remove, ...added);
  }
  let after = Buffer.from(lines.join(""), "utf8");
  if (sha256(after) !== entry.resultSha256) {
    throw Error(`${entry.path}: the result is not the expected one`);
  }
  return after;
}

function main() {
  let [packageDir, treeDir, flag] = process.argv.slice(2);
  if (!packageDir || !treeDir) {
    console.error("Usage: node apply-patches.mjs <package-dir> <tree-dir> [--check]");
    process.exit(2);
  }
  let check = flag === "--check";
  let manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "patches.json"), "utf8"));
  let outputs = [];
  let problems = [];
  for (let entry of manifest.files) {
    let target = path.join(treeDir, entry.path);
    try {
      if (entry.kind === "add") {
        let data = fs.readFileSync(path.join(packageDir, "files", entry.path));
        if (sha256(data) !== entry.sha256) {
          throw Error(`${entry.path}: the package's copy is damaged`);
        }
        if (fs.existsSync(target) && sha256(fs.readFileSync(target)) !== entry.sha256) {
          throw Error(`${entry.path}: the tree already has a different file there`);
        }
        outputs.push({ target, data });
      } else if (entry.kind === "edit") {
        outputs.push({ target, data: applyEdits(fs.readFileSync(target), entry) });
      } else if (entry.kind === "delete") {
        if (sha256(fs.readFileSync(target)) !== entry.baseSha256) {
          throw Error(`${entry.path}: not the expected file to delete`);
        }
        outputs.push({ target, data: null });
      }
    } catch (caught) {
      problems.push(caught.code === "ENOENT" ? `${entry.path}: missing from the tree` : caught.message);
    }
  }
  if (problems.length) {
    console.error(`Nothing written; ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  if (!check) {
    for (let { target, data } of outputs) {
      if (data === null) {
        fs.rmSync(target);
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      }
    }
  }
  console.log(`${check ? "Would apply" : "Applied"} ${outputs.length} file(s) for ${manifest.app ?? "the package's app"}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
