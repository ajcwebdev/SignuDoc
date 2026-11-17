import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { getDb, withTransaction } from "./db/connection.ts";
import { createDraftEnvelope } from "./envelopes.ts";
import { saveSettings } from "./settings.ts";

/** Every visitor gets a real draft owned by their own synthetic account. */
export async function seedDemoWorkspace(userId: string): Promise<string> {
  const database = getDb();
  await withTransaction(async (client) => {
    await client.query(
      `update public."user" set role = 'admin', "emailVerified" = true where id = $1`,
      [userId],
    );
    const existing = await client.query(
      "select id from public.app_settings where id",
    );
    if (!existing.rowCount) {
      await saveSettings(
        {
          organizationName: "SignuDoc Demo",
          supportAddress: "support@example.invalid",
          signupMode: "closed",
          setupCompletedAt: Math.floor(Date.now() / 1000),
        },
        client,
      );
    }
  }, database);

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const lines = [
    "DEMO CONSULTING AGREEMENT",
    "A sample document for trying SignuDoc",
    "",
    "Northstar Studio and Sample Client agree to a fictional design project.",
    "Scope: create three sample website concepts.",
    "Project fee: $800 in fictional funds. No payment is requested.",
    "Delivery: within two weeks of this sample agreement.",
    "",
    "This is demonstration content, not an actual agreement.",
    "Add a signer, place a signature field, then send a mock invitation.",
    "Open the invitation in Settings > Organization > Mock email outbox.",
    "",
    "Signature: __________________________________________",
    "",
    "Date: ______________________________________________",
  ];
  for (const [index, line] of lines.entries()) {
    page.drawText(line, {
      x: 48,
      y: 730 - index * 28,
      size: index === 0 ? 19 : 11,
      font: index === 0 ? bold : regular,
      color: index === 0 ? rgb(0.15, 0.25, 0.38) : rgb(0.2, 0.2, 0.2),
    });
  }
  pdf.setTitle("Demo consulting agreement");
  pdf.setSubject("Fictional sample document for SignuDoc demo mode");

  const result = await createDraftEnvelope(
    userId,
    {
      title: "Demo consulting agreement",
      sourcePdf: {
        body: await pdf.save(),
        contentType: "application/pdf",
        filename: "demo-consulting-agreement.pdf",
      },
    },
    { database },
  );
  return result.envelope.id;
}
