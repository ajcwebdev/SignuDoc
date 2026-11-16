import { createHash, randomUUID } from "node:crypto";

import {
  getDb,
  withTransaction,
  type DbExecutor,
  type DbPool,
} from "../db/connection.ts";
import type { EmailAddresses } from "./email-addresses.ts";
import type {
  EmailDeliveryResult,
  EmailSendOptions,
  TransactionalEmailMessage,
} from "./email.ts";

export type MockEmailAttachment = {
  bytes: number;
  contentType: string;
  filename: string;
  sha256: string;
};

export type MockEmailSummary = {
  id: string;
  sequence: string;
  createdAt: string;
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  template: string;
  attachments: MockEmailAttachment[];
};

export type MockEmail = MockEmailSummary & {
  htmlBody: string | null;
  textBody: string;
};

const summaryColumns = `id, sequence::text, created_at as "createdAt",
  from_address as "from", to_address as "to", reply_to as "replyTo",
  subject, template, attachments`;

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stores an entire request atomically; retries return every original recipient. */
export async function storeMockEmails(
  messages: readonly TransactionalEmailMessage[],
  addresses: EmailAddresses,
  options: EmailSendOptions | undefined,
  kind: "single" | "batch",
  database: DbPool = getDb(),
): Promise<EmailDeliveryResult[]> {
  if (!messages.length) return [];
  if (messages.length > 1000)
    throw new Error("Too many mock email recipients.");

  const payloads = messages.map((message) => ({
    from: addresses.senderAddress,
    to: message.to,
    replyTo: message.replyTo ?? addresses.supportAddress,
    subject: message.subject,
    template: message.template,
    textBody: message.textBody,
    htmlBody: message.htmlBody ?? null,
    // Keep fingerprints and names, never PDF bytes or base64 content.
    attachments: (message.attachments ?? []).map((attachment) => ({
      bytes: attachment.content.byteLength,
      contentType: attachment.contentType,
      filename: attachment.filename,
      sha256: digest(attachment.content),
    })),
  }));
  const fingerprint = digest(JSON.stringify(payloads));
  const key = options?.idempotencyKey
    ? digest(JSON.stringify([kind, options.idempotencyKey]))
    : null;

  try {
    return await withTransaction(async (client) => {
      const requestId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `insert into public.mock_email_requests (id, idempotency_key, fingerprint)
         values ($1, $2, $3) on conflict (idempotency_key) do nothing returning id`,
        [requestId, key, fingerprint],
      );

      if (!inserted.rowCount) {
        const existing = await client.query<{
          id: string;
          fingerprint: string;
        }>(
          `select id, fingerprint from public.mock_email_requests where idempotency_key = $1`,
          [key],
        );
        const request = existing.rows[0];
        if (!request || request.fingerprint !== fingerprint) {
          throw new Error(
            "A mock email idempotency key was reused with different content.",
          );
        }
        const previous = await client.query<{ id: string; to: string }>(
          `select id, to_address as "to" from public.mock_email_outbox
           where request_id = $1 order by position`,
          [request.id],
        );
        return previous.rows.map((row) => ({
          accepted: [row.to],
          messageId: row.id,
          rejected: [],
        }));
      }

      const results: EmailDeliveryResult[] = [];
      for (const [position, payload] of payloads.entries()) {
        const id = `mock-${randomUUID()}`;
        await client.query(
          `insert into public.mock_email_outbox
           (id, request_id, position, from_address, to_address, reply_to, subject,
            template, text_body, html_body, attachments)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [
            id,
            requestId,
            position,
            payload.from,
            payload.to,
            payload.replyTo,
            payload.subject,
            payload.template,
            payload.textBody,
            payload.htmlBody,
            JSON.stringify(payload.attachments),
          ],
        );
        results.push({ accepted: [payload.to], messageId: id, rejected: [] });
      }
      return results;
    }, database);
  } catch {
    // PostgreSQL error details can include row contents and signing tokens.
    // Never propagate those details into route or delivery logs.
    throw new Error(
      "Mock email could not be saved. Check the database and idempotency key.",
    );
  }
}

function normalizeRow<T extends MockEmailSummary>(row: T): T {
  return { ...row, createdAt: new Date(row.createdAt).toISOString() };
}

export async function listMockEmails(
  {
    before = null,
    limit = 20,
  }: { before?: string | null; limit?: number } = {},
  database: DbExecutor = getDb(),
): Promise<{ messages: MockEmailSummary[]; nextBefore: string | null }> {
  const size = Math.min(50, Math.max(1, Math.floor(limit) || 20));
  if (before !== null && !/^[1-9]\d{0,17}$/.test(before)) {
    throw new Error("Invalid outbox cursor.");
  }
  const result = await database.query<MockEmailSummary>(
    `select ${summaryColumns} from public.mock_email_outbox
     where ($1::bigint is null or sequence < $1::bigint)
     order by sequence desc limit $2`,
    [before, size + 1],
  );
  const messages = result.rows.slice(0, size).map(normalizeRow);
  return {
    messages,
    nextBefore: result.rows.length > size ? messages.at(-1)!.sequence : null,
  };
}

export async function getMockEmail(
  id: string,
  database: DbExecutor = getDb(),
): Promise<MockEmail | null> {
  if (!/^mock-[0-9a-f-]{36}$/.test(id)) return null;
  const result = await database.query<MockEmail>(
    `select ${summaryColumns}, text_body as "textBody", html_body as "htmlBody"
     from public.mock_email_outbox where id = $1`,
    [id],
  );
  return result.rows[0] ? normalizeRow(result.rows[0]) : null;
}
