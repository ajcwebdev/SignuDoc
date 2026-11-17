import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function runRelease(overrides) {
  const directory = mkdtempSync(join(tmpdir(), "signudoc-release-test-"));
  const env = { ...process.env };
  for (const key of [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "POSTGRES_URL_NON_POOLING",
    "SIGNUDOC_DEMO_MODE",
    "VERCEL",
  ]) {
    delete env[key];
  }
  try {
    return spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./migrate.mjs", import.meta.url))],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...env, ...overrides },
        timeout: 5_000,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("demo release defers its schema without contacting an inherited database", () => {
  const result = runRelease({
    SIGNUDOC_DEMO_MODE: "1",
    DATABASE_URL: "postgres://demo:unused@unreachable.example.invalid/demo",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /initialized in memory/);
  assert.doesNotMatch(result.stdout + result.stderr, /unreachable/);
});

test("normal release still fails when no database is configured", () => {
  const result = runRelease({ SIGNUDOC_DEMO_MODE: "0" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no database URL found/);
});
