# -*- coding: utf-8 -*-
"""
Visual verification: zoom to max level, compare marker tip vs coordinate point.
"""
from playwright.sync_api import sync_playwright
import json, time

BASE_URL = "http://localhost:8900/src/"

def get_test_communities():
    data = json.load(open("data/processed/communities.json", encoding="utf-8"))
    comms = data["communities"]
    tianlin = [c for c in comms if "\u7530\u6797" in c.get("name", "")][:1]
    pudong  = [c for c in comms if c.get("district", "") == "\u6d66\u4e1c\u65b0\u533a"][:1]
    jingan  = [c for c in comms if c.get("district", "") == "\u9759\u5b89\u533a"][:1]
    result = []
    for g in [tianlin, pudong, jingan]:
        if g:
            c = g[0]
            result.append({"name": c["name"], "lat": c["lat"], "lng": c["lng"], "district": c.get("district", "")})
    return result

def run():
    communities = get_test_communities()
    print("Test communities:")
    for c in communities:
        print(f"  {c['district']} lat={c['lat']} lng={c['lng']}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)
        time.sleep(8)  # wait for AMap SDK + data load

        # Check map available
        has_map = page.evaluate("() => !!(window.__map)")
        print(f"window.__map available: {has_map}")
        if not has_map:
            page.screenshot(path="/tmp/no_map.png")
            print("Saved /tmp/no_map.png for debug")
            browser.close()
            return

        all_pass = True
        for comm in communities:
            print(f"\n=== {comm['name']} ({comm['district']}) ===")
            # Pan to community at zoom 18
            page.evaluate(f"""() => {{
                window.__map.setZoomAndCenter(18, [{comm['lng']}, {comm['lat']}]);
            }}""")
            time.sleep(3)

            fname = f"/tmp/verify_{comm['district']}_z18.png"
            page.screenshot(path=fname)

            # Measure offset between coordinate pixel and nearest tip
            data = page.evaluate(f"""() => {{
                const m = window.__map;
                const pixel = m.lngLatToContainer(new AMap.LngLat({comm['lng']}, {comm['lat']}));
                const mapEl = document.getElementById('map');
                const mapRect = mapEl.getBoundingClientRect();

                const tips = [...document.querySelectorAll('.mk-tip')];
                if (!tips.length) return {{no_tips: true, pixelX: pixel.x, pixelY: pixel.y}};

                let closest = null, minDist = Infinity;
                for (const tip of tips) {{
                    const r = tip.getBoundingClientRect();
                    const tipX = r.left + r.width/2 - mapRect.left;
                    const tipY = r.bottom - mapRect.top;
                    const dx = tipX - pixel.x;
                    const dy = tipY - pixel.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    if (dist < minDist) {{ minDist = dist; closest = {{tipX, tipY, dx, dy, dist, pixelX: pixel.x, pixelY: pixel.y}}; }}
                }}
                return closest;
            }}""")

            if not data:
                print("  No measurement returned")
            elif data.get("no_tips"):
                print(f"  No .mk-tip elements found (pixelCoord=({data['pixelX']:.0f},{data['pixelY']:.0f}))")
                print(f"  Screenshot: {fname}")
            else:
                dx, dy, dist = data["dx"], data["dy"], data["dist"]
                print(f"  coord pixel=({data['pixelX']:.0f},{data['pixelY']:.0f})")
                print(f"  nearest tip=({data['tipX']:.0f},{data['tipY']:.0f})")
                print(f"  offset dx={dx:.1f}px dy={dy:.1f}px dist={dist:.1f}px")
                print(f"  Screenshot: {fname}")
                if dist < 15:
                    print("  PASS")
                else:
                    print("  FAIL - offset too large")
                    all_pass = False

        browser.close()
        return all_pass

if __name__ == "__main__":
    ok = run()
    print(f"\nOverall: {'PASS' if ok else 'FAIL - needs fix'}")
