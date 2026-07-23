import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(repositoryRoot, "tests");
const testFilePattern = /\.test\.(?:mjs|ts)$/u;

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(path)));
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(path);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

const testFiles = await collectTestFiles(testsRoot);
if (testFiles.length === 0) {
  throw new Error("No test files were found");
}

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  cwd: repositoryRoot,
  shell: false,
  stdio: "inherit",
});

const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

if (result.signal) {
  console.error(`Test process terminated by ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.code ?? 1;
}
