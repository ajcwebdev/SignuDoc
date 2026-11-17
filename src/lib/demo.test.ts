import assert from "node:assert/strict";
import { test } from "node:test";

import { hasDemoBackend, isDemoMode } from "./demo.ts";

const demo = {
  SIGNUDOC_DEMO_MODE: "1",
  DATABASE_URL: "postgres://demo:fixture@127.0.0.1:15432/demo",
  EMAIL_DRIVER: "mock",
  STORAGE_DRIVER: "local",
};

test("public demo entry requires an explicit flag and local mock services", () => {
  assert.equal(isDemoMode({}), false);
  assert.equal(isDemoMode({ SIGNUDOC_DEMO_MODE: "true" }), false);
  assert.equal(hasDemoBackend(demo), true);
  assert.equal(hasDemoBackend({ ...demo, SIGNUDOC_DEMO_MODE: "0" }), false);
  assert.equal(hasDemoBackend({ ...demo, EMAIL_DRIVER: "resend" }), false);
  assert.equal(hasDemoBackend({ ...demo, STORAGE_DRIVER: "blob" }), false);
});

test("demo account creation cannot use hosted or missing database connections", () => {
  assert.equal(
    hasDemoBackend({
      ...demo,
      DATABASE_URL: "postgres://user:fixture@sample.neon.tech/db",
    }),
    false,
  );
  assert.equal(hasDemoBackend({ ...demo, DATABASE_URL: "" }), false);
  assert.equal(
    hasDemoBackend({ ...demo, DATABASE_URL: "https://localhost" }),
    false,
  );
  assert.equal(
    hasDemoBackend({
      ...demo,
      DATABASE_URL: "postgres://demo:fixture@[::1]:15432/demo",
    }),
    true,
  );
});
