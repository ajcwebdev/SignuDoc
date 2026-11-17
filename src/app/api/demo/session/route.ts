import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getAuth } from "@/lib/auth/server";
import { runAsSetup } from "@/lib/auth/setup-context";
import { getDb } from "@/lib/db/connection";
import { hasDemoBackend, isDemoMode } from "@/lib/demo";
import { seedDemoWorkspace } from "@/lib/demo-seed";
import { getClientIpAddress } from "@/lib/security/request";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { resolveAppUrl } from "@/lib/utils/env";

const noStore = { "cache-control": "private, no-store" };

export async function POST(request: Request) {
  if (!isDemoMode()) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: noStore },
    );
  }
  if (!hasDemoBackend()) {
    return NextResponse.json(
      { error: "The demo backend is not available." },
      { status: 503, headers: noStore },
    );
  }
  const origin = request.headers.get("origin");
  const expectedOrigin = new URL(resolveAppUrl(process.env) ?? request.url)
    .origin;
  if (
    origin !== expectedOrigin ||
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    return NextResponse.json(
      { error: "Start the demo from this site." },
      { status: 403, headers: noStore },
    );
  }
  const limited = await applyRateLimit({
    category: "demo_session_create",
    key: buildRateLimitKey([
      "demo-session",
      getClientIpAddress(request.headers) ?? "unknown",
    ]),
    limit: 10,
    request,
    windowMs: 10 * 60 * 1000,
  });
  if (limited) {
    limited.headers.set("cache-control", noStore["cache-control"]);
    return limited;
  }

  try {
    const count = await getDb().query<{ count: number }>(
      `select count(*)::int as count from public."user"`,
    );
    if (count.rows[0].count >= 200) {
      return NextResponse.json(
        { error: "This demo is full. Please try again after it resets." },
        { status: 429, headers: noStore },
      );
    }
    const email = `demo-${randomUUID()}@example.invalid`;
    const password = randomBytes(32).toString("hex");
    const auth = getAuth();
    const account = await runAsSetup(() =>
      auth.api.signUpEmail({
        body: { email, name: "Demo Visitor", password },
      }),
    );
    const sampleEnvelopeId = await seedDemoWorkspace(account.user.id);

    // The existing Next cookies plugin writes the normal secure session
    // cookie, exactly as it does for first-run setup. No password or token
    // is returned to JavaScript or shared between visitors.
    await auth.api.signInEmail({
      body: { email, password },
      headers: request.headers,
    });

    return NextResponse.json(
      { redirectTo: "/dashboard", sampleEnvelopeId },
      { status: 201, headers: noStore },
    );
  } catch {
    // Delivery bodies, private passwords and auth tokens stay out of logs.
    return NextResponse.json(
      { error: "The demo could not be started. Please try again." },
      { status: 500, headers: noStore },
    );
  }
}
