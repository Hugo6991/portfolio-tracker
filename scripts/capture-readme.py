#!/usr/bin/env python3
"""Capture README screenshots from a local demo-mode build. Synthetic data only.

  PORTFOLIO_DEMO_MODE=1 npm run dev:preview        (in another terminal; serves 127.0.0.1:3001)
  python3 scripts/capture-readme.py --out scripts/oss/img

Needs python3 with playwright and Pillow. Refuses any host that is not local, and fails if a
page shows a login form, an error state, or horizontal overflow on the phone viewport.
"""
import argparse, pathlib, sys, time
from urllib.parse import urlparse

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:3001")
ap.add_argument("--out", default="scripts/oss/img")
args = ap.parse_args()
if urlparse(args.base).hostname not in ("127.0.0.1", "localhost", "::1"):
    sys.exit("FAIL: only a local build may be captured")
OUT = pathlib.Path(args.out); OUT.mkdir(parents=True, exist_ok=True)

ROUTES = [("/", "dashboard"), ("/assets", "assets"), ("/wallets", "wallets"), ("/exchanges", "exchanges"),
          ("/banks", "banks"), ("/expenses", "expenses"), ("/trading", "trading"), ("/settings", "settings")]
BAD_TEXT = ("Viewer access required", "Viewer access is not configured", "temporarily unavailable", "not ready yet", "Application error")

from playwright.sync_api import sync_playwright
from PIL import Image

def settle(page):
    page.wait_for_load_state("networkidle")
    page.evaluate("document.fonts.ready")
    page.add_style_tag(content="*,*::before,*::after{animation:none!important;transition:none!important}")
    page.wait_for_timeout(1500)
    body = page.inner_text("body")
    hit = [b for b in BAD_TEXT if b in body]
    if hit:
        raise SystemExit(f"FAIL: {page.url} shows {hit}. Next: check PORTFOLIO_DEMO_MODE=1 is set on the server and the route returns demo data")

problems = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2, locale="en-US", timezone_id="Asia/Taipei", reduced_motion="reduce")
    page = ctx.new_page()
    page.on("pageerror", lambda e: problems.append(f"pageerror {e}"))
    for route, name in ROUTES:
        page.goto(args.base + route); settle(page)
        page.screenshot(path=str(OUT / f"page-{name}.png"), full_page=True)
        page.screenshot(path=str(OUT / f"view-{name}.png"))
        print("desktop", name)
    ctx.close()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="en-US", timezone_id="Asia/Taipei", reduced_motion="reduce", is_mobile=True, has_touch=True)
    page = ctx.new_page()
    for route, name in ROUTES:
        page.goto(args.base + route); settle(page)
        if page.evaluate("document.documentElement.scrollWidth > innerWidth"):
            problems.append(f"horizontal overflow on {route} at 390px")
        page.screenshot(path=str(OUT / f"mobile-{name}.png"))
        print("mobile", name)
    ctx.close(); browser.close()

# hero: dashboard desktop beside dashboard mobile
d = Image.open(OUT / "view-dashboard.png"); m = Image.open(OUT / "mobile-dashboard.png")
H = 1800
d2 = d.resize((round(d.width * H / d.height), H), Image.LANCZOS)
m2 = m.resize((round(m.width * H / m.height), H), Image.LANCZOS)
gap = 60
hero = Image.new("RGB", (d2.width + gap + m2.width + 2 * gap, H + 2 * gap), (241, 245, 249))
hero.paste(d2, (gap, gap)); hero.paste(m2, (gap + d2.width + gap, gap))
hero.save(OUT / "hero.png", optimize=True)
# overview grid of the eight desktop views, two columns
tiles = [Image.open(OUT / f"view-{n}.png") for _, n in ROUTES]
tw = 1200; th = round(tiles[0].height * tw / tiles[0].width)
grid = Image.new("RGB", (2 * tw + 3 * 40, 4 * th + 5 * 40), (241, 245, 249))
for i, t in enumerate(tiles):
    grid.paste(t.resize((tw, th), Image.LANCZOS), (40 + (i % 2) * (tw + 40), 40 + (i // 2) * (th + 40)))
grid.save(OUT / "overview-desktop.png", optimize=True)
for f in OUT.glob("view-*.png"):
    f.unlink()
if problems:
    sys.exit("FAIL: " + "; ".join(problems))
print("captured", len(ROUTES), "routes at desktop and phone, plus hero.png and overview-desktop.png in", OUT)
