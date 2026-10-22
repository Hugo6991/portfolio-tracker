import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const SOURCE_REPO_URL = "https://github.com/Hugo6991/portfolio-tracker";

export function SourceLink({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <Button asChild variant="outline" size={compact ? "icon" : "default"} className={cn("h-11 bg-background", compact ? "w-11" : "gap-2 px-3", className)}>
      <a href={SOURCE_REPO_URL} target="_blank" rel="noreferrer" aria-label="Source code on GitHub" title="Source code on GitHub">
        <Github className="h-4 w-4" aria-hidden="true" />
        {compact ? null : <span>GitHub</span>}
      </a>
    </Button>
  );
}
