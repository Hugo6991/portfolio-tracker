import { ImageResponse } from "next/og";
import { PortfolioLogo } from "@/components/shared/PortfolioLogo";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        background: "#F4F8F7"
      }}
    >
      <PortfolioLogo style={{ width: 154, height: 154 }} />
    </div>,
    size
  );
}
