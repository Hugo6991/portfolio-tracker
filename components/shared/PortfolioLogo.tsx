import type { CSSProperties } from "react";

type PortfolioLogoProps = {
  className?: string;
  style?: CSSProperties;
  title?: string;
};

export function PortfolioLogo({ className, style, title }: PortfolioLogoProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : "true"}
    >
      {title ? <title>{title}</title> : null}
      <rect width="64" height="64" rx="15" fill="#168F87" />
      <path
        d="M14 45V20H23C33 20 33 33 23 33H14M36 20H53M44.5 20V45"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
