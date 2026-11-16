import { getDb } from "@/lib/db/connection";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // pg supports a timeout per query; its QueryConfig typings omit this option.
    const query = { text: "select 1", query_timeout: 5_000 };
    await getDb().query(query);
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
