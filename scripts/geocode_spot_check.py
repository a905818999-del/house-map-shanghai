# -*- coding: utf-8 -*-
"""
Use AMap.PlaceSearch (POI) in browser - more accurate than Geocoder for residential communities.
"""
from playwright.sync_api import sync_playwright
import json, time

BASE_URL = "http://localhost:8900/src/"

TARGET_COMMUNITIES = [
    {"name": "\u7530\u6797\u4e5d\u6751", "district": "\u5f90\u6c47\u533a"},
    {"name": "\u7530\u6797\u5341\u4e8c\u6751", "district": "\u5f90\u6c47\u533a"},
    {"name": "\u9526\u7ee3\u5c0f\u533a", "district": "\u6d66\u4e1c\u65b0\u533a"},
]

def poi_search_communities(targets):
    data = json.load(open("data/processed/communities.json", encoding="utf-8"))
    comms_by_name = {c["name"]: c for c in data["communities"]}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)
        time.sleep(8)

        has_map = page.evaluate("() => !!(window.__map)")
        if not has_map:
            print("ERROR: map not available")
            browser.close()
            return []

        results = []
        for t in targets:
            name = t["name"]
            district = t["district"]
            current = comms_by_name.get(name)
            if not current:
                print(f"Not in communities.json: {name}")
                continue

            # PlaceSearch with district restriction
            poi_result = page.evaluate(f"""() => new Promise((resolve) => {{
                const placeSearch = new AMap.PlaceSearch({{
                    city: '\u4e0a\u6d77',
                    citylimit: true,
                    type: '\u4f4f\u5bbf\u533a;120000',
                    pageSize: 5
                }});
                placeSearch.search({json.dumps(district + name)}, function(status, result) {{
                    if (status === 'complete' && result.poiList && result.poiList.pois.length > 0) {{
                        const poi = result.poiList.pois[0];
                        resolve({{
                            lat: poi.location.lat,
                            lng: poi.location.lng,
                            name: poi.name,
                            address: poi.address || ''
                        }});
                    }} else {{
                        resolve({{error: status, result: JSON.stringify(result).slice(0,200)}});
                    }}
                }});
            }})""")

            cur_lat = current["lat"]
            cur_lng = current["lng"]
            print(f"\n{name} ({district})")
            print(f"  current:  lat={cur_lat:.6f}, lng={cur_lng:.6f}")

            if poi_result and not poi_result.get("error"):
                geo_lat = poi_result["lat"]
                geo_lng = poi_result["lng"]
                dlat = geo_lat - cur_lat
                dlng = geo_lng - cur_lng
                dist_m = ((dlat * 111000) ** 2 + (dlng * 88000) ** 2) ** 0.5
                print(f"  poi hit:  lat={geo_lat:.6f}, lng={geo_lng:.6f}")
                print(f"  poi name: {poi_result['name']}")
                print(f"  dist_m:   {dist_m:.0f}m  {'NEEDS FIX' if dist_m > 500 else 'OK'}")
                results.append({
                    "name": name,
                    "current_lat": cur_lat, "current_lng": cur_lng,
                    "geo_lat": geo_lat, "geo_lng": geo_lng,
                    "dist_m": dist_m,
                    "needs_fix": dist_m > 500
                })
            else:
                print(f"  POI search failed: {poi_result}")

        browser.close()
        return results

if __name__ == "__main__":
    results = poi_search_communities(TARGET_COMMUNITIES)
    fixes = [r for r in results if r.get("needs_fix")]
    print(f"\nTotal needing fix: {len(fixes)}")
    for r in fixes:
        print(f"  {r['name']}: {r['dist_m']:.0f}m offset")
