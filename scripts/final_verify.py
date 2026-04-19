# -*- coding: utf-8 -*-
"""Final zoom-18 verification of 田林九村 alignment."""
from playwright.sync_api import sync_playwright
import time

BASE_URL = "http://localhost:8900/src/"

# 田林九村 new coords after fix
LAT, LNG = 31.172764, 121.421834

def verify():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)
        time.sleep(8)

        has_map = page.evaluate("() => !!(window.__map)")
        if not has_map:
            print("ERROR: no map")
            browser.close()
            return

        # Zoom to 18 centered on 田林九村
        page.evaluate(f"() => {{ window.__map.setZoomAndCenter(18, [{LNG}, {LAT}]); }}")
        time.sleep(3)
        page.screenshot(path="D:/tmp/tianlin9_z18.png")
        print("Screenshot: D:/tmp/tianlin9_z18.png")

        # Measure tip vs coord pixel
        m = page.evaluate(f"""() => {{
            const pixel = window.__map.lngLatToContainer(new AMap.LngLat({LNG}, {LAT}));
            const mapRect = document.getElementById('map').getBoundingClientRect();
            const tips = [...document.querySelectorAll('.mk-tip')];
            let closest = null, minDist = Infinity;
            for (const t of tips) {{
                const r = t.getBoundingClientRect();
                const tx = r.left + r.width/2 - mapRect.left;
                const ty = r.bottom - mapRect.top;
                const dist = Math.sqrt((tx-pixel.x)**2 + (ty-pixel.y)**2);
                if (dist < minDist) {{ minDist = dist; closest = {{tx, ty, px: pixel.x, py: pixel.y, dist}}; }}
            }}
            return closest;
        }}""")

        if m:
            print(f"Coord pixel: ({m['px']:.0f}, {m['py']:.0f})")
            print(f"Nearest tip: ({m['tx']:.0f}, {m['ty']:.0f})")
            print(f"Offset dist: {m['dist']:.1f}px")
            if m['dist'] < 15:
                print("PASS - tip aligned with coordinate")
            else:
                print("FAIL - offset too large")
        else:
            print("No tips found at zoom 18")

        browser.close()

if __name__ == "__main__":
    verify()
