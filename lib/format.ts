import type { Currency } from "./fx";

export function formatMoney(value: number, currency: Currency) {
  const amount = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(Math.round(value));

  return normalizeMoneyText(currency === "USD" ? `$${amount}` : `NT$${amount}`);
}

export function formatNullableMoney(value: number | null | undefined, currency: Currency) {
  if (value == null || Number.isNaN(value)) return "Pending valuation";
  return formatMoney(value, currency);
}

export function normalizeMoneyText(value: string) {
  return value.replaceAll("NTNT$", "NT$").replaceAll("NT$NT$", "NT$");
}

export function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

export function compactAddress(address: string | null) {
  if (!address) return "Not connected";
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function daysSince(date: string, now = new Date()) {
  // Accepts a date (2026-10-18) or a full timestamp; both are read as a Taipei calendar day.
  const then = new Date(`${date.slice(0, 10)}T00:00:00+08:00`);
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
}

export function relativeUpdate(date: string, now = new Date()) {
  const days = daysSince(date, now);
  if (days === 0) return "updated today";
  if (days === 1) return "updated yesterday";
  return `updated ${days} days ago`;
}
