"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";
import { useViewerSession } from "@/components/shared/Providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { signOutViewerSession } from "@/lib/client/viewer-session";

export function ViewerSessionControl() {
  const session = useViewerSession();
  const [signingOut, setSigningOut] = useState(false);
  if (!session) return null;

  async function signOut() {
    setSigningOut(true);
    try {
      await signOutViewerSession();
    } catch {
      setSigningOut(false);
    }
  }

  return (
    <div className="grid gap-2 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Access</span>
        <Badge variant={session.role === "admin" ? "success" : "muted"}>
          {session.role === "admin" ? "Admin" : "Read only"}
        </Badge>
      </div>
      <Button variant="outline" size="sm" onClick={() => void signOut()} disabled={signingOut}>
        <LogOut />
        {signingOut ? "Signing out" : "Sign out"}
      </Button>
    </div>
  );
}
