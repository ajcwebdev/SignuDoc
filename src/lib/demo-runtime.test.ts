import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import pg from "pg";

import {
  buildDemoEnvironment,
  isDemoMode,
  startDemoBackend,
} from "../../scripts/demo-backend.mjs";

test("the disposable backend requires the explicit demo switch", async () => {
  assert.equal(isDemoMode({}), false);
  assert.equal(isDemoMode({ SIGNUDOC_DEMO_MODE: "true" }), false);
  assert.equal(isDemoMode({ SIGNUDOC_DEMO_MODE: "1" }), true);
  await assert.rejects(startDemoBackend({ env: {} }), /SIGNUDOC_DEMO_MODE=1/);
});

test("demo mode replaces external services without mutating operator config", () => {
  const env = {
    DATABASE_URL: "postgresql://example.invalid/real",
    POSTGRES_URL: "postgresql://example.invalid/another",
    BLOB_READ_WRITE_TOKEN: "test-only-real-blob-placeholder",
    RESEND_API_KEY: "test-only-real-email-placeholder",
    SEAL_P12_BASE64: "test-only-real-certificate-placeholder",
    SEAL_TIMESTAMP_URL: "https://example.invalid/timestamp",
    EIDEASY_SECRET: "test-provider-secret",
    CSC_CLIENT_SECRET: "test-provider-secret",
    SSO_CLIENT_SECRET: "test-sso-secret",
    SIGNING_PROVIDER: "eideasy",
    BACKUP_BLOB_READ_WRITE_TOKEN: "test-backup-token",
    EMAIL_DRIVER: "resend",
    STORAGE_DRIVER: "blob",
    PASSWORD_SIGN_IN: "off",
    BETTER_AUTH_SECRET: "test-auth-secret-kept-stable-within-this-demo",
    APP_URL: "https://demo.example.invalid",
  };
  const databaseUrl =
    "postgresql://postgres:demo-fixture-only@127.0.0.1:15432/postgres?sslmode=disable";
  const child = buildDemoEnvironment(env, {
    databaseUrl,
    storageDir: "/tmp/signudoc-demo-test",
  });
  assert.equal(child.DATABASE_URL, databaseUrl);
  assert.equal(child.DATABASE_URL_UNPOOLED, databaseUrl);
  assert.equal(child.EMAIL_DRIVER, "mock");
  assert.equal(child.STORAGE_DRIVER, "local");
  assert.equal(child.STORAGE_LOCAL_DIR, "/tmp/signudoc-demo-test");
  assert.equal(child.SIGNUDOC_SCHEDULED_JOBS, "off");
  assert.equal(child.PASSWORD_SIGN_IN, "on");
  assert.equal(child.PASSWORD_BREACH_CHECK, "off");
  assert.equal(child.BETTER_AUTH_SECRET, env.BETTER_AUTH_SECRET);
  assert.equal(child.APP_URL, env.APP_URL);
  for (const key of [
    "POSTGRES_URL",
    "BLOB_READ_WRITE_TOKEN",
    "RESEND_API_KEY",
    "SEAL_P12_BASE64",
    "SEAL_TIMESTAMP_URL",
    "EIDEASY_SECRET",
    "CSC_CLIENT_SECRET",
    "SSO_CLIENT_SECRET",
    "SIGNING_PROVIDER",
    "BACKUP_BLOB_READ_WRITE_TOKEN",
  ]) {
    assert.equal(child[key], undefined);
  }
  assert.equal(env.STORAGE_DRIVER, "blob");
  assert.equal(env.EMAIL_DRIVER, "resend");
});

test("unencrypted demo SQL is restricted to its private loopback endpoint", () => {
  for (const databaseUrl of [
    "postgresql://external.example.invalid:5432/postgres?sslmode=disable",
    "postgresql://127.0.0.1:5432/postgres?sslmode=verify-full",
    "https://127.0.0.1:5432/postgres?sslmode=disable",
  ]) {
    assert.throws(
      () =>
        buildDemoEnvironment(
          {},
          { databaseUrl, storageDir: "/tmp/signudoc-demo-test" },
        ),
      /private loopback/,
    );
  }
});

test("the demo backend applies real migrations, isolates transactions and discards its files", async () => {
  const messages: string[] = [];
  const backend = await startDemoBackend({
    env: { SIGNUDOC_DEMO_MODE: "1" },
    log: (message) => messages.push(message),
    loadSnapshot: false,
  });
  const pool = new pg.Pool({
    connectionString: backend.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    max: 3,
  });
  try {
    const migrations = await pool.query(
      "select count(*)::int as count from public.signudoc_migrations",
    );
    assert.equal(migrations.rows[0].count, 18);
    assert.deepEqual(messages, [
      "[demo] In-memory backend ready; demo data resets on restart.",
    ]);
    assert.ok(!messages.join(" ").includes("postgresql://"));
    await pool.query(
      "create table demo_runtime_probe (id integer primary key)",
    );
    const writer = await pool.connect();
    const reader = await pool.connect();
    try {
      await writer.query("begin");
      await writer.query("insert into demo_runtime_probe values (1)");
      let readFinished = false;
      const read = reader
        .query("select count(*)::int as count from demo_runtime_probe")
        .then((result) => {
          readFinished = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(readFinished, false);
      await writer.query("rollback");
      assert.equal((await read).rows[0].count, 0);
    } finally {
      writer.release();
      reader.release();
    }
    await writeFile(
      path.join(backend.env.STORAGE_LOCAL_DIR!, "owned-demo-fixture.txt"),
      "temporary demo content",
    );
  } finally {
    await pool.end();
    await backend.close();
    await backend.close();
  }
  await assert.rejects(access(backend.env.STORAGE_LOCAL_DIR!));
  const ended = new pg.Client({
    connectionString: backend.env.DATABASE_URL,
    connectionTimeoutMillis: 500,
  });
  await assert.rejects(ended.connect());
  await ended.end().catch(() => undefined);
});
