export const SMALL_BALANCE_THRESHOLD_USD = 50;

type UsdBalance = {
  valueUsd: number;
};

export function partitionSmallBalances<T extends UsdBalance>(balances: readonly T[]) {
  const visible: T[] = [];
  const hidden: T[] = [];
  let hiddenTotalUsd = 0;

  for (const balance of balances) {
    if (Math.abs(balance.valueUsd) < SMALL_BALANCE_THRESHOLD_USD) {
      hidden.push(balance);
      hiddenTotalUsd += balance.valueUsd;
    } else {
      visible.push(balance);
    }
  }

  return {
    visible,
    hidden,
    hiddenCount: hidden.length,
    hiddenTotalUsd
  };
}
