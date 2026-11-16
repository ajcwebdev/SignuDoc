import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { sendTestEmail } from "../email-test.ts";
import {
  createEmailService,
  resolveEmailDriver,
  type TransactionalEmailMessage,
} from "./email.ts";
import {
  getMockEmail,
  listMockEmails,
  storeMockEmails,
} from "./mock-email-outbox.ts";

let database: pg.Pool;
let replaced: pg.Pool | null;
const addresses = {
  senderAddress: "Acme <sign@acme.example>",
  supportAddress: "help@acme.example",
};
const message: TransactionalEmailMessage = {
  to: "signer@acme.example",
  subject: "Sign this document",
  template: "test_email",
  textBody: "Open https://sign.acme.example/sign/private-bearer-token",
  htmlBody:
    '<a href="https://sign.acme.example/sign/private-bearer-token">Sign</a>',
};

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
});
beforeEach(async () => {
  await database.query(
    "truncate public.mock_email_requests, public.mock_email_outbox restart identity",
  );
});
after(async () => {
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

test("production mock sends without a provider key and persists links through another connection", async () => {
  let calls = 0;
  const service = createEmailService({
    env: {
      EMAIL_DRIVER: "mock",
      NODE_ENV: "production",
      APP_URL: "https://sign.acme.example",
    },
    resolveAddresses: async () => addresses,
    resendClient: {
      emails: {
        send: async () => {
          calls++;
          throw new Error("Must not call Resend");
        },
      },
    } as never,
  });
  const result = await service.send(message);
  assert.deepEqual(result.accepted, [message.to]);
  assert.match(result.messageId!, /^mock-/);
  assert.equal(calls, 0);
  const connection = await database.connect();
  try {
    const stored = await getMockEmail(result.messageId!, connection);
    assert.equal(stored?.textBody, message.textBody);
    assert.equal(stored?.htmlBody, message.htmlBody);
    assert.equal(stored?.replyTo, addresses.supportAddress);
    assert.ok(Date.parse(stored!.createdAt));
  } finally {
    connection.release();
  }
});

test("single retries including concurrent sends return one durable message", async () => {
  const send = () =>
    storeMockEmails(
      [message],
      addresses,
      { idempotencyKey: "single-key" },
      "single",
      database,
    );
  const results = await Promise.all(Array.from({ length: 6 }, send));
  assert.equal(new Set(results.map((result) => result[0]!.messageId)).size, 1);
  assert.equal((await listMockEmails({}, database)).messages.length, 1);
});

test("the administrator test email is usable in mock mode without configuring Resend", async () => {
  const result = await sendTestEmail({
    env: {
      EMAIL_DRIVER: "mock",
      NODE_ENV: "production",
      APP_URL: "https://sign.acme.example",
    },
    name: "Administrator",
    to: "owner@acme.example",
  });
  assert.deepEqual(result, { sent: true, to: "owner@acme.example" });
  const { messages } = await listMockEmails({}, database);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.template, "test_email");
  assert.equal(messages[0]!.to, "owner@acme.example");
});

test("batch retry preserves every recipient, including duplicate addresses", async () => {
  const messages = [
    message,
    { ...message, to: "second@acme.example" },
    message,
  ];
  const options = { idempotencyKey: "batch-key" };
  const first = await storeMockEmails(
    messages,
    addresses,
    options,
    "batch",
    database,
  );
  const retry = await storeMockEmails(
    messages,
    addresses,
    options,
    "batch",
    database,
  );
  assert.deepEqual(retry, first);
  assert.equal(new Set(first.map((result) => result.messageId)).size, 3);
  assert.deepEqual(
    first.map((result) => result.accepted[0]),
    messages.map((item) => item.to),
  );
  await assert.rejects(
    storeMockEmails(
      [...messages, message],
      addresses,
      options,
      "batch",
      database,
    ),
    /could not be saved/,
  );
  assert.equal((await listMockEmails({}, database)).messages.length, 3);
});

test("attachments retain metadata and hashes while never storing PDF bytes", async () => {
  const bytes = Buffer.from("private raw PDF content must not persist");
  const [delivery] = await storeMockEmails(
    [
      {
        ...message,
        attachments: [
          {
            content: bytes,
            contentType: "application/pdf",
            filename: "contract.pdf",
          },
        ],
      },
    ],
    addresses,
    undefined,
    "single",
    database,
  );
  const stored = await getMockEmail(delivery!.messageId!, database);
  assert.deepEqual(stored!.attachments, [
    {
      bytes: bytes.length,
      contentType: "application/pdf",
      filename: "contract.pdf",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ]);
  const rows = await database.query(
    "select row_to_json(m)::text as value from public.mock_email_outbox m",
  );
  assert.ok(!rows.rows[0].value.includes(bytes.toString()));
  assert.ok(!rows.rows[0].value.includes(bytes.toString("base64")));
});

test("paginated summaries exclude bodies and idempotency keys; detail lookup rejects malformed IDs", async () => {
  await storeMockEmails(
    [message, message, message],
    addresses,
    { idempotencyKey: "private-key" },
    "batch",
    database,
  );
  const first = await listMockEmails({ limit: 2 }, database);
  assert.equal(first.messages.length, 2);
  assert.ok(first.nextBefore);
  const next = await listMockEmails(
    { limit: 2, before: first.nextBefore },
    database,
  );
  assert.equal(next.messages.length, 1);
  assert.equal(next.nextBefore, null);
  assert.ok(!JSON.stringify(first).includes("private-bearer-token"));
  assert.ok(!JSON.stringify(first).includes("private-key"));
  assert.equal(await getMockEmail("' OR true --", database), null);
  await assert.rejects(
    listMockEmails({ before: "invalid" }, database),
    /Invalid outbox cursor/,
  );
});

test("oversized rows roll the entire batch back and never disclose body contents in errors", async () => {
  const secret = "private-token-" + "x".repeat(1048576);
  await assert.rejects(
    storeMockEmails(
      [message, { ...message, textBody: secret }],
      addresses,
      undefined,
      "batch",
      database,
    ),
    (error: Error) => {
      assert.ok(!error.message.includes("private-token"));
      return /could not be saved/.test(error.message);
    },
  );
  assert.equal((await listMockEmails({}, database)).messages.length, 0);
  const requests = await database.query(
    "select count(*)::int as total from public.mock_email_requests",
  );
  assert.equal(requests.rows[0].total, 0);
});

test("capture remains forbidden for a public production deployment", () => {
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "mock" }), "mock");
  assert.throws(
    () =>
      createEmailService({
        env: {
          EMAIL_DRIVER: "capture",
          NODE_ENV: "production",
          APP_URL: "https://sign.acme.example",
        },
      }),
    /cannot be used in production/,
  );
});
