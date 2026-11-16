import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { logSecurityEvent } from "@/lib/security/logging";
import { getMockEmail } from "@/lib/services/mock-email-outbox";

const noStore = { "cache-control": "private, no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminSession(request);
  if (session instanceof Response) {
    session.headers.set("cache-control", noStore["cache-control"]);
    return session;
  }
  try {
    const { id } = await params;
    const message = await getMockEmail(id);
    return message
      ? NextResponse.json({ message }, { headers: noStore })
      : NextResponse.json(
          { error: "Mock email not found." },
          { headers: noStore, status: 404 },
        );
  } catch {
    logSecurityEvent("error", {
      category: "mock_email_outbox_read_failure",
      message: "The mock email could not be read.",
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "The mock email could not be read." },
      { headers: noStore, status: 500 },
    );
  }
}
