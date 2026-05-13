/**
 * Bridge runner: load `.env.local` via @next/env (same path the rest of
 * the labeler uses), then spawn a child process with that env inherited.
 *
 * Lets sibling-repo scripts (e.g. the bisaya-reconstruction Python
 * importers) see the labeler's DATABASE_URL without us reading or echoing
 * the secret value at any point.
 *
 * Usage:
 *   tsx scripts/run-with-env.ts --cwd <dir> -- <command> [args...]
 *
 * Example:
 *   tsx scripts/run-with-env.ts \
 *     --cwd ../bisaya-reconstruction \
 *     -- python -m service.scripts.migrate_sqlite_to_postgres --dry-run
 */
import { loadEnvConfig } from "@next/env";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function parseArgs(argv: string[]): { cwd: string; cmd: string[] } {
  let cwd = process.cwd();
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--cwd") {
      cwd = resolve(argv[i + 1] ?? ".");
      i += 2;
      continue;
    }
    if (a === "--") {
      return { cwd, cmd: argv.slice(i + 1) };
    }
    break;
  }
  throw new Error(
    "missing '--' separator; usage: --cwd <dir> -- <command> [args...]",
  );
}

const { cwd, cmd } = parseArgs(process.argv.slice(2));
if (cmd.length === 0) {
  console.error("no command after --");
  process.exit(2);
}

// Load .env.local from THIS project (the labeler) regardless of where the
// child process will run. @next/env does not echo values to stdout.
loadEnvConfig(process.cwd());

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL not loaded — make sure scripts/run-with-env.ts runs " +
      "from the labeler repo root so @next/env can find .env.local",
  );
  process.exit(2);
}

const [bin, ...rest] = cmd;
const result = spawnSync(bin, rest, {
  cwd,
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32", // python.exe on Windows needs shell:true
});
process.exit(result.status ?? 1);
