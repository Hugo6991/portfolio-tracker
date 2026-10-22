import type { LiveHolding } from "./live-portfolio";

export const dashboardHoldingMinimumUsd = 50;
export const dashboardHoldingLimit = 6;

export type DashboardHoldingSlice = {
  id: string;
  label: string;
  detail: string;
  valueUsd: number;
  holdingCount: number;
  isOther: boolean;
};

export type DashboardHoldingBreakdown = {
  slices: DashboardHoldingSlice[];
  totalUsd: number;
  otherHoldingCount: number;
};

type DashboardHoldingInput = Pick<LiveHolding, "symbol" | "name" | "valueUsd">;

export function buildDashboardHoldingBreakdown(
  holdings: readonly DashboardHoldingInput[]
): DashboardHoldingBreakdown {
  const valuedHoldings = holdings
    .filter((holding) => Number.isFinite(holding.valueUsd) && holding.valueUsd > 0)
    .slice()
    .sort((left, right) => right.valueUsd - left.valueUsd);
  const totalUsd = valuedHoldings.reduce((sum, holding) => sum + holding.valueUsd, 0);
  const eligibleHoldings = valuedHoldings.filter(
    (holding) => holding.valueUsd >= dashboardHoldingMinimumUsd
  );
  const visibleHoldings = eligibleHoldings.slice(0, dashboardHoldingLimit);
  const otherHoldings = [
    ...eligibleHoldings.slice(dashboardHoldingLimit),
    ...valuedHoldings.filter((holding) => holding.valueUsd < dashboardHoldingMinimumUsd)
  ];
  const otherValueUsd = otherHoldings.reduce((sum, holding) => sum + holding.valueUsd, 0);

  const slices: DashboardHoldingSlice[] = visibleHoldings.map((holding) => ({
    id: holding.symbol,
    label: holding.symbol.toUpperCase().endsWith("-ESTIMATE") ? holding.name : holding.symbol,
    detail: holding.symbol.toUpperCase().endsWith("-ESTIMATE")
      ? "Estimated account total · not an asset position"
      : holding.name,
    valueUsd: holding.valueUsd,
    holdingCount: 1,
    isOther: false
  }));

  if (otherValueUsd > 0) {
    slices.push({
      id: "other",
      label: "Other",
      detail: `${otherHoldings.length} ${otherHoldings.length === 1 ? "asset" : "assets"}`,
      valueUsd: otherValueUsd,
      holdingCount: otherHoldings.length,
      isOther: true
    });
  }

  return {
    slices,
    totalUsd,
    otherHoldingCount: otherHoldings.length
  };
}
