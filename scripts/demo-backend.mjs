import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runMigrations } from "../db/migrate.mjs";

const snapshotPath = fileURLToPath(
  new URL("../.next/demo-schema.tar.gz", import.meta.url),
);

export function isDemoMode(
  env = /** @type {Record<string, string | undefined>} */ (process.env),
) {
  return env.SIGNUDOC_DEMO_MODE === "1";
}

/**
 * Demo services must never inherit an external database, mail provider or
 * object store. These overrides are private to the supervised Next process.
 * @param {Record<string, string | undefined>} env
 * @param {{databaseUrl: string, storageDir: string}} resources
 * @returns {Record<string, string | undefined>}
 */
export function buildDemoEnvironment(env, { databaseUrl, storageDir }) {
  const target = new URL(databaseUrl);
  if (
    target.protocol !== "postgresql:" ||
    target.hostname !== "127.0.0.1" ||
    !target.port ||
    target.searchParams.get("sslmode") !== "disable"
  ) {
    throw new Error("The demo database must use its private loopback socket.");
  }

  const demo = { ...env };
  for (const key of [
    "POSTGRES_URL",
    "POSTGRES_URL_NON_POOLING",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGSSLCERT",
    "PGSSLKEY",
    "BLOB_READ_WRITE_TOKEN",
    "BLOB_STORE_ID",
    "BACKUP_BLOB_READ_WRITE_TOKEN",
    "NEXT_PUBLIC_VERCEL_BLOB_API_URL",
    "RESEND_API_KEY",
    "EIDEASY_API_URL",
    "EIDEASY_CLIENT_ID",
    "EIDEASY_SECRET",
  ]) {
    delete demo[key];
  }
  for (const key of Object.keys(demo)) {
    if (
      /^(SEAL_P12|SEAL_TIMESTAMP_URL|EIDEASY_|CSC_|SIGNING_PROVIDER|SSO_|BACKUP_BLOB)/.test(
        key,
      )
    ) {
      delete demo[key];
    }
  }

  return {
    ...demo,
    SIGNUDOC_DEMO_MODE: "1",
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrl,
    BETTER_AUTH_SECRET:
      demo.BETTER_AUTH_SECRET?.trim() || randomBytes(32).toString("hex"),
    EMAIL_DRIVER: "mock",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
    SIGNUDOC_SCHEDULED_JOBS: "off",
    PASSWORD_SIGN_IN: "on",
    PASSWORD_BREACH_CHECK: "off",
  };
}

/**
 * A disposable PostgreSQL-compatible mock backend for one web instance.
 * The database is memory-only; files belong to a fresh directory removed
 * when this instance exits. It is deliberately not a durable deployment.
 * @param {{env?: Record<string, string | undefined>, log?: (message: string) => void, loadSnapshot?: boolean}} [options]
 */
export async function startDemoBackend({
  env = process.env,
  log = console.log,
  loadSnapshot = true,
} = {}) {
  if (!isDemoMode(env)) {
    throw new Error("Set SIGNUDOC_DEMO_MODE=1 to start the demo backend.");
  }

  const storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-demo-"));
  /** @type {import("@electric-sql/pglite").PGlite | undefined} */
  let database;
  /** @type {import("@electric-sql/pglite-socket").PGLiteSocketServer | undefined} */
  let server;
  /** @type {Promise<void> | undefined} */
  let closing;

  function close() {
    closing ??= (async () => {
      try {
        await server?.stop();
      } finally {
        try {
          await database?.close();
        } finally {
          await rm(storageDir, { force: true, recursive: true });
        }
      }
    })();
    return closing;
  }

  try {
    const [{ PGlite }, { PGLiteSocketServer }] = await Promise.all([
      import("@electric-sql/pglite"),
      import("@electric-sql/pglite-socket"),
    ]);
    let data;
    if (loadSnapshot) {
      try {
        data = new Blob([await readFile(snapshotPath)]);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
    database = await PGlite.create({
      loadDataDir: data,
      // Keep room for the Next server and PDF processing on a small dyno.
      postgresqlconf: [
        "shared_buffers=16MB",
        "work_mem=4MB",
        "maintenance_work_mem=16MB",
      ],
    });
    server = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 30,
      inspect: false,
      debug: false,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:demo-fixture-only@${server.getServerConn()}/postgres?sslmode=disable`;
    const childEnv = buildDemoEnvironment(env, { databaseUrl, storageDir });
    await runMigrations({ connectionString: databaseUrl, log: () => {} });
    log("[demo] In-memory backend ready; demo data resets on restart.");
    const readyDatabase = database;
    return {
      env: childEnv,
      close,
      snapshot: () => readyDatabase.dumpDataDir("gzip"),
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw new Error("Could not initialize the in-memory demo backend.", {
      cause: error,
    });
  }
}

export async function prepareDemoSnapshot() {
  if (!isDemoMode()) return;
  const backend = await startDemoBackend({
    loadSnapshot: false,
    log: () => {},
  });
  try {
    const data = await backend.snapshot();
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, Buffer.from(await data.arrayBuffer()));
    console.log("[demo] Disposable backend schema prepared for startup.");
  } finally {
    await backend.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv.includes("--prepare")
) {
  prepareDemoSnapshot().catch(() => {
    console.error("[demo] Could not prepare the disposable backend schema.");
    process.exitCode = 1;
  });
}
