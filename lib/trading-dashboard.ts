export type TradingDashboardSnapshot = {
  schemaVersion: "1.1";
  generatedAt: string;
  stage: "canary";
  mode: "active" | "paused" | "exit-only" | "complete";
  privacy: { publicReadOnly: true; containsSecrets: false };
  chain: { chainId: 4663; status: "healthy" | "degraded" | "unavailable"; primaryBlock: string | null; secondaryBlock: string | null; blockDelta: string | null; maximumBlockDelta: "10" };
  wallet: { alias: string; address: string; explorerUrl: string; usdgBalance: number | null; wethBalance: number | null; ethGasBalance: number | null };
  performance: { initialCapitalUsdg: 100; currentUsdg: number | null; realizedGrossPnlUsdg: number | null; confirmedExecutionGasEth: number; netPnlUsdg: null; netPnlReason: "ETH_GAS_NOT_CONVERTED_TO_USDG" };
  progress: { completedRoundTrips: number; maximumRoundTrips: 5; confirmedOrders: number; pendingOrders: number; openPositions: number };
  equityCurve: Array<{ cycleNumber: number; occurredAt: string; realizedGrossPnlUsdg: number; cumulativeGrossPnlUsdg: number }>;
  trades: Array<{
    cycleNumber: number; status: "open" | "closed"; tokenSymbol: string; tokenAddress: string; entryUsdg: number; exitUsdg: number | null;
    realizedGrossPnlUsdg: number | null; confirmedExecutionGasEth: number; openedAt: string; closedAt: string | null;
    entryTxHash: string | null; entryExplorerUrl: string | null; exitTxHash: string | null; exitExplorerUrl: string | null; exitReasonCodes: string[];
  }>;
  decision: { executionMode: "execution-canary"; strategyPipeline: "not-connected"; positionState: "NONE" | "HOLD" | "EXIT_REQUIRED" | "UNKNOWN_FAIL_CLOSED"; reasonCodes: string[] };
  walletCandidates: Array<{
    address: string; explorerUrl: string; status: "quarantined" | "tracked" | "rejected" | "stale"; lastSeenAt: string;
    completeRoundTrips: number; activeDays: number; netRealizedPnlUsdg: number | null; winRatePercent: number | null;
    maximumDrawdownUsdg: number | null; medianHoldingMinutes: number | null; coveragePercent: number;
    performanceStatus: "insufficient_sample" | "partial" | "reviewable" | "tracked" | "rejected"; reasonCodes: string[];
  }>;
};

export const isTradingSnapshotStale = (snapshot: TradingDashboardSnapshot, now = Date.now()): boolean =>
  now - new Date(snapshot.generatedAt).getTime() > 120_000;

export const shortAddress = (address: string): string => address.length < 14 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;

const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const formatUsdg = (value: number | null): string => value === null
  ? "N/A"
  : `${wholeNumber.format(value)} USDG`;

export const formatSignedUsdg = (value: number | null): string => {
  if (value === null) return "N/A";

  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const magnitude = Math.abs(value);

  if (magnitude > 0 && magnitude < 0.01) return `${sign}<1¢`;
  if (magnitude < 1) return `${sign}${wholeNumber.format(magnitude * 100)}¢`;
  return `${sign}${wholeNumber.format(magnitude)} USDG`;
};

export const formatEth = (value: number | null): string => value === null
  ? "N/A"
  : value === 0
    ? "0 ETH"
    : `${wholeNumber.format(value * 1_000_000_000)} gwei`;
