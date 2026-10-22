import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpenseMonthTooltip } from "./ExpenseMonthTooltip";

describe("ExpenseMonthTooltip", () => {
  it("shows the hovered month and its TWD total", () => {
    const markup = renderToStaticMarkup(
      <ExpenseMonthTooltip
        active
        currency="TWD"
        label="2026-08"
        payload={[{ payload: { month: "2026-08", total: 480801.16 } }] as never}
      />
    );

    expect(markup).toContain("2026-08");
    expect(markup).toContain("Historical total");
    expect(markup).toContain("NT$480,801");
  });

  it("stays hidden when no chart point is active", () => {
    expect(renderToStaticMarkup(<ExpenseMonthTooltip currency="USD" />)).toBe("");
  });

  it("keeps a forecast, historical partial actual, and confirmed ledger separate", () => {
    const markup = renderToStaticMarkup(
      <ExpenseMonthTooltip
        active
        currency="TWD"
        payload={[{
          payload: {
            month: "2026-09",
            total: 357514.43,
            baselineStatus: "forecast",
            historicalActualTotal: 16605.35,
            historicalActualThrough: "2026-09-02",
            ledgerTotal: 48250,
            ledgerThrough: "2026-09-30",
            ledgerRecordCount: 12
          }
        }] as never}
      />
    );

    expect(markup).toContain("Forecast total");
    expect(markup).toContain("NT$357,514");
    expect(markup).toContain("Historical actual NT$16,605 through Sep 2");
    expect(markup).toContain("Confirmed ledger");
    expect(markup).toContain("NT$48,250");
    expect(markup).toContain("12 records through Sep 30");
  });
});
