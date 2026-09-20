import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Template Importer",
  description:
    "Import a Spectora inspection template, edit it, and copy it — without losing the tuning work behind it.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-[var(--line)] bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-tight">
                Template Importer
              </span>
              <span className="text-xs text-[var(--muted)]">
                Spectora &rarr; Hive
              </span>
            </Link>
            <nav className="text-sm">
              <Link
                href="/"
                className="text-[var(--muted)] hover:text-[var(--ink)]"
              >
                Templates
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-7">{children}</main>
        <footer className="mx-auto max-w-6xl px-5 pb-10 pt-4 text-xs text-[var(--muted)]">
          Built for the Hive Inspect Forward Deployed Engineer assignment.
        </footer>
      </body>
    </html>
  );
}
