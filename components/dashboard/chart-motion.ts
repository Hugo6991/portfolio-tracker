"use client";

import { useReducedMotion } from "framer-motion";

/**
 * Shared chart motion. A series draws in once when the chart mounts so the number
 * arrives with its shape; hover feedback stays fast enough to follow the pointer.
 * Reduced motion keeps every chart static.
 */
export function useChartMotion() {
  const reduce = useReducedMotion();
  return {
    isAnimationActive: !reduce,
    animationBegin: 0,
    animationDuration: 600,
    animationEasing: "ease-out" as const
  };
}

/** Tooltips glide a short distance instead of trailing the pointer for 400ms. */
export function useTooltipMotion() {
  const reduce = useReducedMotion();
  return { isAnimationActive: !reduce, animationDuration: 120, animationEasing: "ease-out" as const };
}

export const chartCursor = {
  stroke: "hsl(var(--muted-foreground))",
  strokeOpacity: 0.35,
  strokeWidth: 1,
  strokeDasharray: "3 3"
} as const;

export function chartActiveDot(color: string) {
  return { r: 4.5, fill: color, stroke: "hsl(var(--card))", strokeWidth: 2 } as const;
}
