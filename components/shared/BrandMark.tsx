"use client";

import Image from "next/image";
import { useState } from "react";
import { Coins, Building2, Layers } from "lucide-react";
import { resolveAssetMark, resolveLogoMark, resolveSourceMark } from "@/lib/brand-marks";
import { cn } from "@/lib/utils";

type MarkSize = "sm" | "md";

const markSizes: Record<MarkSize, { box: string; image: number }> = {
  // Keep the complete square image inside the circle, including its corners.
  sm: { box: "h-6 w-6 text-xs", image: 14 },
  md: { box: "h-9 w-9 text-xs", image: 24 }
};

type BrandMarkProps = {
  label: string;
  src: string | null;
  size?: MarkSize;
  className?: string;
  kind?: "asset" | "source" | "protocol";
};

function BrandMark({ label, src, size = "md", className, kind = "asset" }: BrandMarkProps) {
  const dimensions = markSizes[size];
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const visibleSrc = src && failedSrc !== src ? src : null;
  const Fallback = kind === "source" ? Building2 : kind === "protocol" ? Layers : Coins;

  return (
    <span
      className={cn(
        "grid aspect-square shrink-0 place-items-center overflow-hidden rounded-full border border-border/60 bg-white font-semibold text-muted-foreground",
        dimensions.box,
        className
      )}
      aria-hidden="true"
      data-brand-label={label}
    >
      {visibleSrc ? (
        <Image
          src={visibleSrc}
          alt=""
          width={dimensions.image}
          height={dimensions.image}
          unoptimized
          className="aspect-square object-contain"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(visibleSrc)}
        />
      ) : (
        <Fallback size={dimensions.image} strokeWidth={1.5} />
      )}
    </span>
  );
}

export function AssetMark({ symbol, iconUrl, size, className }: { symbol: string; iconUrl?: string | null; size?: MarkSize; className?: string }) {
  return <BrandMark label={symbol} src={resolveAssetMark(symbol, iconUrl)} size={size} className={className} />;
}

export function ProtocolMark({ name, iconUrl, size }: { name: string; iconUrl?: string | null; size?: MarkSize }) {
  return <BrandMark label={name} src={resolveLogoMark(iconUrl)} size={size} kind="protocol" />;
}

export function SourceMark({ source, size = "sm", className }: { source: string; size?: MarkSize; className?: string }) {
  const mark = resolveSourceMark(source);
  return (
    <BrandMark
      label={source}
      kind="source"
      src={mark}
      size={size}
      className={cn(mark && "bg-white", className)}
    />
  );
}
