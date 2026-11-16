import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { logSecurityEvent } from "@/lib/security/logging";
import { listMockEmails } from "@/lib/services/mock-email-outbox";

const noStore = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  const session = await requireAdminSession(request);
  if (session instanceof Response) {
    session.headers.set("cache-control", noStore["cache-control"]);
    return session;
  }
  const parameters = new URL(request.url).searchParams;
  const before = parameters.get("before");
  const rawLimit = parameters.get("limit");
  if (
    (before !== null && !/^[1-9]\d{0,17}$/.test(before)) ||
    (rawLimit !== null && !/^(?:[1-9]|[1-4]\d|50)$/.test(rawLimit))
  ) {
    return NextResponse.json(
      { error: "Invalid outbox pagination." },
      { headers: noStore, status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await listMockEmails({ before, limit: rawLimit ? Number(rawLimit) : 20 }),
      { headers: noStore },
    );
  } catch {
    // Do not log database errors: their details may contain email bodies.
    logSecurityEvent("error", {
      category: "mock_email_outbox_read_failure",
      message: "The mock email outbox could not be read.",
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "The mock email outbox could not be read." },
      { headers: noStore, status: 500 },
    );
  }
}
