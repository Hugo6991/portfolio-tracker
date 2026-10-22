"use client";

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-xl rounded-lg border bg-card p-6">
      <h1 className="text-2xl font-semibold">This page could not load</h1>
      <p className="mt-3 text-sm text-muted-foreground">Try again, or reload to get the latest version</p>
      <div className="mt-5 flex gap-3">
        <button type="button" className="rounded-md border px-4 py-2" onClick={reset}>Try again</button>
        <button type="button" className="rounded-md border px-4 py-2" onClick={() => window.location.reload()}>Reload page</button>
      </div>
    </div>
  );
}
