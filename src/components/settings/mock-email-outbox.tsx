"use client";

import { useEffect, useState, type ReactNode } from "react";

import { ShellButton } from "@/components/shared/form-shell";

type MockMessage = {
  id: string;
  sequence: string;
  createdAt: string;
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  template: string;
  attachments: {
    filename: string;
    contentType: string;
    bytes: number;
    sha256: string;
  }[];
};

type MockMessageDetail = MockMessage & { textBody: string };
type OutboxResponse = {
  messages?: MockMessage[];
  nextBefore?: string | null;
  error?: string;
};

function responseError(response: Response) {
  return response.status === 401 || response.status === 403
    ? "Only an administrator can open the mock email outbox. Sign in again with an administrator account."
    : "The mock email outbox could not be loaded. Please try again.";
}

// Display text as text. Only links back to this application become clickable.
function messagePreview(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const matches = text.matchAll(/https?:\/\/[^\s<>"']+/g);
  let cursor = 0;

  for (const match of matches) {
    const start = match.index;
    const candidate = match[0].replace(/[.,;!?)\]]+$/, "");
    parts.push(text.slice(cursor, start));

    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.origin === window.location.origin &&
        !url.username &&
        !url.password
      ) {
        parts.push(
          <a
            className="font-semibold text-(--accent-ink) underline underline-offset-4"
            href={url.href}
            key={start}
            rel="noopener noreferrer"
            target="_blank"
          >
            {candidate}
          </a>,
        );
      } else {
        parts.push(candidate);
      }
    } catch {
      parts.push(candidate);
    }

    cursor = start + candidate.length;
  }

  parts.push(text.slice(cursor));
  return parts;
}

export function MockEmailOutbox({ revision = 0 }: { revision?: number }) {
  const [messages, setMessages] = useState<MockMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MockMessageDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/admin/email/outbox?limit=20", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as OutboxResponse | null;
        if (!response.ok || !payload?.messages)
          throw new Error(responseError(response));
        setMessages(payload.messages);
        setNextBefore(payload.nextBefore ?? null);
        setError(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "The mock email outbox could not be loaded.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [revision, refresh]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();

    fetch(`/api/admin/email/outbox/${encodeURIComponent(selectedId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          message?: MockMessageDetail;
        } | null;
        if (!response.ok || !payload?.message)
          throw new Error(responseError(response));
        setDetail(payload.message);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setDetailError(
            error instanceof Error
              ? error.message
              : "This mock email could not be loaded.",
          );
      });

    return () => controller.abort();
  }, [selectedId]);

  async function loadMore() {
    if (!nextBefore || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/email/outbox?limit=20&before=${encodeURIComponent(nextBefore)}`,
        { cache: "no-store" },
      );
      const payload = (await response
        .json()
        .catch(() => null)) as OutboxResponse | null;
      if (!response.ok || !payload?.messages)
        throw new Error(responseError(response));
      setMessages((current) => [...current, ...payload.messages!]);
      setNextBefore(payload.nextBefore ?? null);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The mock email outbox could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4" id="mock-email-outbox">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-bold text-(--fg)">Mock email outbox</h4>
        <ShellButton
          disabled={loading}
          loading={loading}
          onClick={() => {
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
          variant="secondary"
        >
          Refresh outbox
        </ShellButton>
      </div>
      <p className="text-sm leading-6 text-(--secondary)">
        Administrators can open signing invitations and verification links here.
        These messages are private to this installation; recipients receive no
        email.
      </p>
      {error ? (
        <p className="notice notice-danger" role="alert">
          {error}
        </p>
      ) : null}
      {loading && messages.length === 0 ? (
        <p className="text-sm text-(--secondary)" role="status">
          Loading mock emails…
        </p>
      ) : null}
      {!loading && !error && messages.length === 0 ? (
        <p className="text-sm text-(--secondary)">
          No mock emails yet. Send a document invitation or create a mock test
          email to see it here.
        </p>
      ) : null}
      {messages.length > 0 ? (
        <ul className="divide-y divide-(--border) rounded-2xl border border-(--border)">
          {messages.map((message) => (
            <li key={message.id}>
              <button
                aria-expanded={selectedId === message.id}
                className="w-full space-y-1 px-4 py-3 text-left hover:bg-(--surface) focus-visible:outline-2 focus-visible:outline-(--accent)"
                onClick={() => {
                  setDetail(null);
                  setDetailError(null);
                  setSelectedId((current) =>
                    current === message.id ? null : message.id,
                  );
                }}
                type="button"
              >
                <span className="block break-words text-sm font-bold text-(--fg)">
                  {message.subject}
                </span>
                <span className="block break-all text-sm text-(--secondary)">
                  To: {message.to}
                </span>
                <time
                  className="block text-xs text-(--tertiary)"
                  dateTime={message.createdAt}
                >
                  {new Date(message.createdAt).toLocaleString()}
                </time>
              </button>
              {selectedId === message.id ? (
                <div className="space-y-3 border-t border-(--border) px-4 py-4">
                  {detailError ? (
                    <p className="notice notice-danger" role="alert">
                      {detailError}
                    </p>
                  ) : !detail ? (
                    <p className="text-sm text-(--secondary)" role="status">
                      Loading preview…
                    </p>
                  ) : (
                    <>
                      <p className="break-all text-xs text-(--tertiary)">
                        From: {detail.from}
                        {detail.replyTo ? ` · Reply to: ${detail.replyTo}` : ""}
                      </p>
                      <div className="whitespace-pre-wrap break-words text-sm leading-6 text-(--secondary)">
                        {messagePreview(detail.textBody)}
                      </div>
                      {detail.attachments.length > 0 ? (
                        <p className="text-xs text-(--tertiary)">
                          Attachments recorded:{" "}
                          {detail.attachments
                            .map(
                              (attachment) =>
                                `${attachment.filename} (${attachment.bytes} bytes)`,
                            )
                            .join(", ")}
                          . Attachment files are not stored in this outbox.
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {nextBefore ? (
        <ShellButton
          disabled={loading}
          loading={loading}
          onClick={() => void loadMore()}
          variant="secondary"
        >
          Load older emails
        </ShellButton>
      ) : null}
    </div>
  );
}
