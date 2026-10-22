"use client";

import { FormEvent, useState } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { PortfolioLogo } from "@/components/shared/PortfolioLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ViewerLoginForm({ returnTo }: { returnTo: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/viewer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, returnTo })
      });
      const body = await response.json() as { error?: string; returnTo?: string };
      if (!response.ok) throw new Error(body.error || "Access could not be verified");
      window.location.replace(body.returnTo || "/");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Access could not be verified");
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/20 px-5 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-7 shadow-card sm:p-8">
        <PortfolioLogo className="h-11 w-11 shadow-xs" />
        <p className="mt-7 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Owner tools</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Owner access</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Browsing needs no password. Owner access is only for updating records
        </p>
        <form className="mt-7 grid gap-4" onSubmit={submit}>
          <label className="grid gap-2 text-sm font-medium" htmlFor="viewer-password">
            Access password
            <Input
              id="viewer-password"
              autoComplete="current-password"
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />
          </label>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <Button className="w-full" type="submit" disabled={submitting || !password}>
            {submitting ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}
            {submitting ? "Checking access" : "Open owner tools"}
          </Button>
        </form>
      </div>
    </main>
  );
}
