import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isDemoMode, startDemoBackend } from "./demo-backend.mjs";

export function resolvePort(
  env = /** @type {Record<string, string | undefined>} */ (process.env),
) {
  const value = env.PORT?.trim() || "8080";
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("PORT must be a number between 1 and 65535.");
  }
  return String(Number(value));
}

export function nextDailyRun(hour, now = Date.now()) {
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

// Call only the local server: the job secret never leaves this container.
// Retry readiness, never a job POST: a timed-out job may still be working.
export async function runMaintenance(
  path,
  {
    port,
    env = /** @type {Record<string, string | undefined>} */ (process.env),
    signal,
    fetchRequest = fetch,
    wait = (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      }),
  },
) {
  const secret = env.RETENTION_JOB_SECRET?.trim() || env.CRON_SECRET?.trim();
  if (!secret) return "missing job secret";

  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 6 && !signal.aborted; attempt++) {
    let ready = false;
    try {
      const response = await fetchRequest(`${origin}/api/health`, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      ready = response.ok;
      await response.body?.cancel();
    } catch {
      // The server or database may still be starting.
    }
    if (ready && !signal.aborted) {
      try {
        const response = await fetchRequest(`${origin}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        });
        await response.body?.cancel();
        return response.ok ? "completed" : `HTTP ${response.status}`;
      } catch {
        return signal.aborted ? "stopped" : "request failed or timed out";
      }
    }
    if (attempt < 5 && !signal.aborted) await wait(10_000, signal);
  }
  return signal.aborted ? "stopped" : "server or database not ready";
}

export function startDailyJobs({
  port,
  env = /** @type {Record<string, string | undefined>} */ (process.env),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  run = runMaintenance,
  log = console.log,
}) {
  const controller = new AbortController();
  const timers = new Set();
  function schedule(path, hour) {
    const currentTime = now();
    const timer = setTimer(
      async () => {
        timers.delete(timer);
        try {
          const result = await run(path, {
            port,
            env,
            signal: controller.signal,
          });
          if (!controller.signal.aborted)
            log(`[maintenance] ${path}: ${result}`);
        } catch {
          if (!controller.signal.aborted) log(`[maintenance] ${path}: failed`);
        } finally {
          if (!controller.signal.aborted) schedule(path, hour);
        }
      },
      nextDailyRun(hour, currentTime) - currentTime,
    );
    timers.add(timer);
  }
  if (env.SIGNUDOC_SCHEDULED_JOBS !== "off") {
    schedule("/api/internal/retention", 9);
    if (env.BACKUP_BLOB_READ_WRITE_TOKEN?.trim()) {
      schedule("/api/internal/backup", 8);
    }
  }
  return () => {
    controller.abort();
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  };
}

/**
 * @param {import("node:events").EventEmitter & Pick<import("node:child_process").ChildProcess, "kill">} child
 * @param {() => void} stopJobs
 * @param {{events?: import("node:events").EventEmitter, exit?: (code: number) => void, cleanup?: () => Promise<void>}} [options]
 */
export function supervise(
  child,
  stopJobs,
  { events = process, exit = (code) => process.exit(code), cleanup } = {},
) {
  let stopping = false;
  let finished = false;
  let killTimer;
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    stopJobs();
    child.kill(signal);
    killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    killTimer.unref();
  }
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  events.on("SIGTERM", onTerm);
  events.on("SIGINT", onInt);
  function finish(code) {
    if (finished) return;
    finished = true;
    stopJobs();
    clearTimeout(killTimer);
    events.removeListener("SIGTERM", onTerm);
    events.removeListener("SIGINT", onInt);
    if (cleanup) {
      Promise.resolve()
        .then(cleanup)
        .then(
          () => exit(code),
          () => {
            console.error("[demo] Could not finish demo cleanup.");
            exit(1);
          },
        );
    } else {
      exit(code);
    }
  }
  child.once("error", () => {
    console.error("[web] Could not start Next.js.");
    finish(1);
  });
  child.once("exit", (code, signal) => {
    finish(stopping ? 0 : (code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}

async function main() {
  const port = resolvePort();
  let startupStopped = false;
  const stopStartup = () => {
    startupStopped = true;
  };
  process.once("SIGTERM", stopStartup);
  process.once("SIGINT", stopStartup);
  let demo;
  try {
    if (isDemoMode()) demo = await startDemoBackend();
  } finally {
    process.removeListener("SIGTERM", stopStartup);
    process.removeListener("SIGINT", stopStartup);
  }
  if (startupStopped) {
    await demo?.close();
    return;
  }
  const env = demo?.env ?? process.env;
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/next/dist/bin/next", import.meta.url),
      ),
      "start",
      "--hostname",
      "0.0.0.0",
      "--port",
      port,
    ],
    {
      stdio: "inherit",
      env: { ...env, NODE_ENV: "production", PORT: port },
    },
  );
  supervise(child, startDailyJobs({ port, env }), { cleanup: demo?.close });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Could not start web process.",
    );
    process.exitCode = 1;
  });
}
