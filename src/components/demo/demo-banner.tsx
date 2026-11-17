import Link from "next/link";

export function DemoBanner() {
  return (
    <aside className="border-b border-(--border) bg-(--accent-soft) px-4 py-2 text-center text-xs leading-5 text-(--fg)">
      <strong>Demo mode</strong> · Use sample data. Changes reset when
      restarted. Emails stay in the mock outbox.{" "}
      <Link className="font-semibold underline underline-offset-2" href="/">
        Start a new demo
      </Link>
    </aside>
  );
}
