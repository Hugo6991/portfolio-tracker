#!/usr/bin/env python3
"""Record the core information each dashboard page shows, so a redesign can prove it kept it.

  python3 scripts/core-numbers.py --base http://127.0.0.1:3002 --out docs/redesign/core-numbers-before.json
  python3 scripts/core-numbers.py --base http://127.0.0.1:3002 --compare docs/redesign/core-numbers-before.json

For every route it collects the distinct money amounts, percentages and table column headers
visible in <main> at a desktop viewport. Duplicates collapse, so removing a repeated total is
fine; losing a value or a column fails. Timestamps and relative times are ignored because demo
fixtures move with the clock.
Exit 1 on any missing value, with the page, the value and the next step.
"""
import argparse, json, re, sys
from playwright.sync_api import sync_playwright

ROUTES = ["/", "/assets", "/wallets", "/exchanges", "/banks", "/expenses", "/trading", "/settings"]
MONEY = re.compile(r"[-+]?(?:NT)?\$\s?\d[\d,]*(?:\.\d+)?[KkMm]?")
PCT = re.compile(r"[-+]?\d+(?:\.\d+)?%")

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:3002")
ap.add_argument("--out")
ap.add_argument("--compare")
args = ap.parse_args()


def collect(page):
    try:
        page.wait_for_load_state("networkidle", timeout=15_000)
    except Exception:
        pass  # pages that poll never go idle; the fixed wait below covers them
    page.wait_for_timeout(2500)
    text = page.locator("main").inner_text()
    heads = [h.strip() for h in page.locator("main th").all_inner_texts() if h.strip()]
    return {
        "money": sorted(set(m.replace(" ", "") for m in MONEY.findall(text))),
        "percent": sorted(set(PCT.findall(text))),
        "columns": sorted(set(heads)),
    }


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 900})
    result = {}
    for r in ROUTES:
        page.goto(args.base + r, timeout=120_000)
        result[r] = collect(page)
    b.close()

if args.out:
    with open(args.out, "w") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    print(f"recorded {sum(len(v['money']) for v in result.values())} amounts, {sum(len(v['columns']) for v in result.values())} columns across {len(ROUTES)} pages -> {args.out}")

if args.compare:
    before = json.load(open(args.compare))
    missing = []
    for r in ROUTES:
        for key in ("money", "percent", "columns"):
            lost = sorted(set(before[r][key]) - set(result[r][key]))
            if lost:
                missing.append(f"{r} {key}: {lost[:8]}{' ...' if len(lost) > 8 else ''}")
    if missing:
        print("FAIL core information changed:\n  " + "\n  ".join(missing) +
              "\nNext: put each value back on its page, or if a value was a pure duplicate on another page, record why in docs/redesign/README.md", file=sys.stderr)
        sys.exit(1)
    print("core information unchanged on all pages")
