import type { EnvSource } from "./utils/env.ts";

export function isDemoMode(env: EnvSource = process.env): boolean {
  return env.SIGNUDOC_DEMO_MODE === "1";
}

/** Public demo account creation must never point at a hosted data store. */
export function hasDemoBackend(env: EnvSource = process.env): boolean {
  if (
    !isDemoMode(env) ||
    env.EMAIL_DRIVER !== "mock" ||
    env.STORAGE_DRIVER !== "local"
  ) {
    return false;
  }
  try {
    const database = new URL(env.DATABASE_URL ?? "");
    return (
      ["postgres:", "postgresql:"].includes(database.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
    );
  } catch {
    return false;
  }
}
