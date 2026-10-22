import { ImageResponse } from "next/og";
import { PortfolioLogo } from "@/components/shared/PortfolioLogo";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site-metadata";

const chartBars = [72, 112, 88, 148, 126, 184];

export function renderSocialCard() {
  return new ImageResponse(
    <div
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#F4F8F7",
        color: "#0A0A0A",
        fontFamily: "Arial, sans-serif",
        padding: "72px 80px"
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 12,
          display: "flex",
          background: "#168F87"
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: 710,
          height: "100%"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <PortfolioLogo style={{ width: 96, height: 96 }} />
          <div
            style={{
              display: "flex",
              marginTop: 34,
              fontSize: 68,
              lineHeight: 1.02,
              fontWeight: 700,
              letterSpacing: "-3px"
            }}
          >
            {SITE_NAME}
          </div>
          <div
            style={{
              display: "flex",
              maxWidth: 680,
              marginTop: 24,
              color: "#50605D",
              fontSize: 29,
              lineHeight: 1.36
            }}
          >
            {SITE_DESCRIPTION}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            width: 250,
            border: "1px solid #C8D7D4",
            borderRadius: 999,
            padding: "10px 18px",
            color: "#31514D",
            fontSize: 20,
            fontWeight: 600
          }}
        >
          Freshness at a glance
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 330,
          height: 410,
          marginLeft: "auto",
          marginTop: 38,
          border: "1px solid #D7E1DF",
          borderRadius: 30,
          background: "#FFFFFF",
          boxShadow: "0 24px 60px rgba(18, 51, 47, 0.12)",
          padding: "30px 28px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", color: "#60716E", fontSize: 18, fontWeight: 600 }}>
            Net worth
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#168F87", fontSize: 15, fontWeight: 700 }}>
            <div style={{ display: "flex", width: 9, height: 9, borderRadius: 99, background: "#22C55E" }} />
            SOURCE CHECKS
          </div>
        </div>
        <div style={{ display: "flex", marginTop: 16, fontSize: 42, fontWeight: 700, letterSpacing: "-2px" }}>
          One clear view
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 16,
            height: 210,
            marginTop: 26,
            padding: "0 8px 0 4px",
            borderBottom: "1px solid #DDE7E5"
          }}
        >
          {chartBars.map((height, index) => (
            <div
              key={height}
              style={{
                display: "flex",
                width: 28,
                height,
                borderRadius: "10px 10px 2px 2px",
                background: index === chartBars.length - 1 ? "#168F87" : "#B7D8D3"
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 22, color: "#71807E", fontSize: 15 }}>
          <span>Allocation</span>
          <span>History</span>
        </div>
      </div>
    </div>,
    { width: 1200, height: 630 }
  );
}
