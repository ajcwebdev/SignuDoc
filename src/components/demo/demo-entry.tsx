"use client";

import { useState } from "react";

import { Brand } from "@/components/layout/brand";
import { ShellButton } from "@/components/shared/form-shell";

export function DemoEntry() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startDemo() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/demo/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = (await response.json()) as {
        redirectTo?: string;
        error?: string;
      };
      if (!response.ok || payload.redirectTo !== "/dashboard") {
        throw new Error(
          payload.error ?? "The demo could not be started. Please try again.",
        );
      }
      window.location.assign(payload.redirectTo);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The demo could not be started.",
      );
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[85vh] flex-col">
      <header className="page-width py-6">
        <Brand />
      </header>
      <main className="page-width flex flex-1 items-center justify-center py-12">
        <section className="panel w-full max-w-xl space-y-6 p-8 sm:p-10">
          <span className="pill pill-accent">Interactive demo</span>
          <h1 className="text-3xl font-extrabold tracking-tight text-(--fg)">
            Try SignuDoc
          </h1>
          <p className="leading-7 text-(--secondary)">
            Start with a sample agreement, add a signer, place a signature and
            complete the signing flow. No account setup or email service is
            needed.
          </p>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-(--secondary)">
            <li>Open the sample draft in your documents.</li>
            <li>Add a fictional signer and send the invitation.</li>
            <li>
              Open Settings, Organization, Mock email outbox to follow its
              signing link.
            </li>
          </ol>
          <p className="text-sm leading-6 text-(--tertiary)">
            Use sample data. Each visit starts a new demo account; the mock
            email outbox and organization settings are shared. Changes reset
            when the app restarts, and nothing is emailed externally.
          </p>
          {error ? (
            <p className="notice notice-danger" role="alert">
              {error}
            </p>
          ) : null}
          <ShellButton
            loading={loading}
            disabled={loading}
            onClick={() => void startDemo()}
          >
            Try the demo
          </ShellButton>
        </section>
      </main>
    </div>
  );
}
