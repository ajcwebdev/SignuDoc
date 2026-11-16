import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  nextDailyRun,
  resolvePort,
  runMaintenance,
  startDailyJobs,
  supervise,
} from "../../scripts/build-start.mjs";

test("Build uses its assigned port, defaulting to 8080", () => {
  assert.equal(resolvePort({}), "8080");
  assert.equal(resolvePort({ PORT: "49152" }), "49152");
  for (const PORT of ["0", "65536", "abc", "8080 --inspect"]) {
    assert.throws(() => resolvePort({ PORT }), /PORT/);
  }
});

test("maintenance runs at 08:00 and 09:00 UTC across day and year boundaries", () => {
  const now = Date.parse("2026-12-31T08:30:00Z");
  assert.equal(nextDailyRun(8, now), Date.parse("2027-01-01T08:00:00Z"));
  assert.equal(nextDailyRun(9, now), Date.parse("2026-12-31T09:00:00Z"));
  assert.equal(
    nextDailyRun(9, Date.parse("2026-12-31T09:00:00Z")),
    Date.parse("2027-01-01T09:00:00Z"),
  );
});

test("jobs wait for database readiness and send runtime secrets only to loopback", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const waits: number[] = [];
  const result = await runMaintenance("/api/internal/retention", {
    port: "43210",
    env: { RETENTION_JOB_SECRET: "test-only-secret" },
    signal: new AbortController().signal,
    wait: async (ms: number) => {
      waits.push(ms);
    },
    fetchRequest: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: calls.length === 1 ? 503 : 200 });
    },
  });
  assert.equal(result, "completed");
  assert.deepEqual(waits, [10_000]);
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "http://127.0.0.1:43210/api/health",
      "http://127.0.0.1:43210/api/health",
      "http://127.0.0.1:43210/api/internal/retention",
    ],
  );
  assert.equal(calls[0].init?.headers, undefined);
  assert.equal(calls[2].init?.method, "POST");
  assert.deepEqual(calls[2].init?.headers, {
    authorization: "Bearer test-only-secret",
  });
  assert.equal(calls[2].init?.redirect, "error");
});

test("failed maintenance is not retried and CRON_SECRET works", async () => {
  let posts = 0;
  const result = await runMaintenance("/api/internal/backup", {
    port: "8080",
    env: { CRON_SECRET: "test-cron-secret" },
    signal: new AbortController().signal,
    fetchRequest: async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.method) return new Response(null, { status: 200 });
      posts++;
      assert.deepEqual(init.headers, {
        authorization: "Bearer test-cron-secret",
      });
      throw new Error("test-only timeout");
    },
  });
  assert.equal(result, "request failed or timed out");
  assert.equal(posts, 1);
});

test("readiness retries are bounded and shutdown prevents any job", async () => {
  let calls = 0;
  const controller = new AbortController();
  const options = {
    port: "8080",
    env: { CRON_SECRET: "test-secret" },
    signal: controller.signal,
    wait: async () => {},
    fetchRequest: async () => {
      calls++;
      return new Response(null, { status: 503 });
    },
  };
  assert.equal(
    await runMaintenance("/api/internal/retention", options),
    "server or database not ready",
  );
  assert.equal(calls, 6);
  controller.abort();
  assert.equal(
    await runMaintenance("/api/internal/retention", options),
    "stopped",
  );
  assert.equal(calls, 6);
});

test("scheduler cancels pending daily jobs on shutdown", (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.parse("2026-11-16T07:59:59Z"),
  });
  const messages: string[] = [];
  const stop = startDailyJobs({
    port: "8080",
    env: {},
    log: (message: string) => messages.push(message),
  });
  stop();
  context.mock.timers.tick(48 * 60 * 60 * 1000);
  assert.deepEqual(messages, []);
});

test("the scheduler invokes optional backup at 08:00 and retention at 09:00", async (context) => {
  context.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.parse("2026-11-16T07:59:59Z"),
  });
  const paths: string[] = [];
  const stop = startDailyJobs({
    port: "8080",
    env: { BACKUP_BLOB_READ_WRITE_TOKEN: "test-only-backup-token" },
    run: async (path: string) => {
      paths.push(path);
      return "completed";
    },
    log: () => {},
  });
  context.after(stop);
  context.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.deepEqual(paths, ["/api/internal/backup"]);
  context.mock.timers.tick(3_600_000);
  await Promise.resolve();
  assert.deepEqual(paths, ["/api/internal/backup", "/api/internal/retention"]);
});

test("an absent job secret skips the authenticated job", async () => {
  assert.equal(
    await runMaintenance("/api/internal/retention", {
      port: "8080",
      env: {},
      signal: new AbortController().signal,
      fetchRequest: async () => {
        assert.fail("must not make an anonymous job request");
      },
    }),
    "missing job secret",
  );
});

test("supervisor forwards shutdown and propagates an unexpected Next exit", () => {
  for (const shutdown of [false, true]) {
    const events = new EventEmitter();
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(String(signal));
        return true;
      },
    });
    let stopped = 0;
    let exitCode: number | undefined;
    supervise(
      child,
      () => {
        stopped++;
      },
      {
        events,
        exit: (code: number) => {
          exitCode = code;
        },
      },
    );
    if (shutdown) events.emit("SIGTERM");
    child.emit("exit", shutdown ? null : 23, shutdown ? "SIGTERM" : null);
    assert.equal(exitCode, shutdown ? 0 : 23);
    assert.equal(stopped, shutdown ? 2 : 1);
    assert.deepEqual(signals, shutdown ? ["SIGTERM"] : []);
    assert.equal(events.listenerCount("SIGTERM"), 0);
  }
});
