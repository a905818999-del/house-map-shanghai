"""
批量用高德 Geocoder 验证并修复 communities.json 里坐标可疑的记录。
使用 Playwright + page.evaluate 在浏览器中调用高德 JS API 进行 geocoding。

用法:
  python scripts/geocode_verify.py           # 全量扫描 + geocode + 修复
  python scripts/geocode_verify.py --fix     # 根据已有 results 文件直接修复
"""
import json
import math
import sys
import time
import argparse
from pathlib import Path
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

COMMUNITIES_FILE = Path('D:/Claude Code Project/house map/data/processed/communities.json')
CANDIDATES_FILE = Path('/tmp/geocode_candidates.json')
RESULTS_FILE = Path('/tmp/geocode_results.json')

AMAP_KEY = '1cf0650cf8cc24f862e1d3a1d023b93c'
AMAP_SEC = 'e808269f0141b67e76ee446b1542b3c0'

# Threshold: if geocoder result differs from current by >500m, it's a fix candidate
FIX_THRESHOLD_M = 500

# Realistic bounding boxes for Shanghai districts (GCJ-02)
DISTRICT_STRICT_BOUNDS = {
    '浦东新区': (30.82, 31.55, 121.44, 122.22),
    '闵行区':   (30.97, 31.29, 121.25, 121.58),
    '杨浦区':   (31.23, 31.37, 121.47, 121.62),
    '长宁区':   (31.17, 31.27, 121.35, 121.48),
    '徐汇区':   (31.13, 31.26, 121.39, 121.52),
    '静安区':   (31.21, 31.31, 121.39, 121.52),
    '普陀区':   (31.19, 31.33, 121.33, 121.47),
    '宝山区':   (31.26, 31.51, 121.34, 121.63),
    '松江区':   (30.96, 31.14, 121.03, 121.45),
    '嘉定区':   (31.24, 31.50, 121.07, 121.50),
    '虹口区':   (31.24, 31.33, 121.45, 121.55),
    '黄浦区':   (31.18, 31.26, 121.45, 121.53),
    '青浦区':   (31.01, 31.32, 120.88, 121.25),
    '奉贤区':   (30.81, 31.04, 121.22, 121.75),
    '金山区':   (30.60, 30.86, 120.88, 121.52),
    '崇明区':   (31.38, 31.89, 121.08, 121.98),
}

# Default fallback coordinate used when original geocode failed
DEFAULT_COORD = (31.235929, 121.480539)


def haversine(lat1, lng1, lat2, lng2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


# Minimal HTML page that loads AMap Geocoder
GEOCODER_HTML = f"""
<!DOCTYPE html><html><head><meta charset="utf-8">
<script>
  window._AMapSecurityConfig = {{ securityJsCode: '{AMAP_SEC}' }};
</script>
<script src="https://webapi.amap.com/maps?v=2.0&key={AMAP_KEY}&plugin=AMap.Geocoder"></script>
</head><body><div id="status">loading</div></body></html>
"""


def find_candidates(communities):
    """Find all records with suspicious coordinates."""
    candidates = []
    seen = set()
    for c in communities:
        if c['name'] in seen:
            continue
        lat, lng = c['lat'], c['lng']
        district = c.get('district', '')
        reason = None

        # Check 1: default coordinate
        if (abs(lat - DEFAULT_COORD[0]) < 0.000001
                and abs(lng - DEFAULT_COORD[1]) < 0.000001):
            reason = 'default_coord'
        # Check 2: outside district bounds
        elif district in DISTRICT_STRICT_BOUNDS:
            lat_min, lat_max, lng_min, lng_max = DISTRICT_STRICT_BOUNDS[district]
            if not (lat_min <= lat <= lat_max and lng_min <= lng <= lng_max):
                reason = 'outside_district'

        if reason:
            candidates.append({
                'name': c['name'],
                'district': district,
                'lat': lat,
                'lng': lng,
                'reason': reason,
            })
            seen.add(c['name'])

    return candidates


def run_geocode_batch(candidates):
    """Geocode a batch using Playwright. Returns list of result dicts."""
    from playwright.sync_api import sync_playwright

    results = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-proxy-server'],
        )
        context = browser.new_context()
        page = context.new_page()

        # Load the inline HTML with AMap
        page.set_content(GEOCODER_HTML)

        # Wait for AMap to load (up to 30s)
        # Use typeof check to avoid "Cannot call a class as a function" error
        print('  Waiting for AMap...', flush=True)
        try:
            page.wait_for_function(
                '() => typeof window.AMap !== "undefined" && typeof window.AMap.Geocoder !== "undefined"',
                timeout=30000,
            )
            print('  AMap ready.', flush=True)
        except Exception as e:
            print(f'  AMap failed to load: {e}', flush=True)
            browser.close()
            return results

        for i, cand in enumerate(candidates):
            name = cand['name']
            district = cand.get('district', '')
            cur_lat = cand['lat']
            cur_lng = cand['lng']

            try:
                result = page.evaluate(
                    """async (name) => {
                        return new Promise(resolve => {
                            const gc = new AMap.Geocoder({ city: '上海', limit: 1 });
                            gc.getLocation(name, (status, res) => {
                                if (status === 'complete' && res.geocodes && res.geocodes.length > 0) {
                                    const loc = res.geocodes[0].location;
                                    resolve({ ok: true, lat: loc.lat, lng: loc.lng });
                                } else {
                                    resolve({ ok: false, lat: null, lng: null });
                                }
                            });
                        });
                    }""",
                    name,
                )

                if result and result.get('ok'):
                    geo_lat = result['lat']
                    geo_lng = result['lng']
                    dist = haversine(cur_lat, cur_lng, geo_lat, geo_lng)
                    results.append({
                        'name': name,
                        'district': district,
                        'current_lat': cur_lat,
                        'current_lng': cur_lng,
                        'geocoder_lat': geo_lat,
                        'geocoder_lng': geo_lng,
                        'distance_m': round(dist),
                        'needs_fix': dist > FIX_THRESHOLD_M,
                        'reason': cand.get('reason', ''),
                    })
                    flag = '*** FIX ***' if dist > FIX_THRESHOLD_M else 'ok'
                    print(
                        f'  [{i+1}/{len(candidates)}] {district} {name}: '
                        f'{dist:.0f}m {flag}',
                        flush=True,
                    )
                else:
                    results.append({
                        'name': name,
                        'district': district,
                        'current_lat': cur_lat,
                        'current_lng': cur_lng,
                        'geocoder_lat': None,
                        'geocoder_lng': None,
                        'distance_m': None,
                        'needs_fix': False,
                        'error': 'geocode_failed',
                        'reason': cand.get('reason', ''),
                    })
                    print(
                        f'  [{i+1}/{len(candidates)}] {district} {name}: GEOCODE FAILED',
                        flush=True,
                    )

            except Exception as e:
                print(f'  [{i+1}/{len(candidates)}] {name}: ERROR {e}', flush=True)
                results.append({
                    'name': name,
                    'district': district,
                    'current_lat': cur_lat,
                    'current_lng': cur_lng,
                    'geocoder_lat': None,
                    'geocoder_lng': None,
                    'distance_m': None,
                    'needs_fix': False,
                    'error': str(e),
                    'reason': cand.get('reason', ''),
                })

            time.sleep(0.15)  # 150ms rate limit

        browser.close()

    return results


def apply_fixes(results):
    """Apply geocoder-confirmed fixes to communities.json."""
    with open(COMMUNITIES_FILE, encoding='utf-8') as f:
        data = json.load(f)

    fix_map = {}
    for r in results:
        if r.get('needs_fix') and r.get('geocoder_lat'):
            fix_map[r['name']] = r

    if not fix_map:
        print('No fixes to apply.')
        return 0

    fixed = 0
    for c in data['communities']:
        name = c.get('name', '')
        if name in fix_map:
            r = fix_map[name]
            print(
                f'  Fix: {c.get("district","")} {name}\n'
                f'    [{c["lat"]:.6f}, {c["lng"]}]'
                f' -> [{r["geocoder_lat"]:.6f}, {r["geocoder_lng"]:.6f}]'
                f'  ({r["distance_m"]}m off)',
            )
            c['lat'] = r['geocoder_lat']
            c['lng'] = r['geocoder_lng']
            fixed += 1

    with open(COMMUNITIES_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    return fixed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fix-only', action='store_true',
                        help='Skip geocoding, apply fixes from existing results file')
    parser.add_argument('--batch-size', type=int, default=50)
    args = parser.parse_args()

    if args.fix_only:
        print('=== Fix-only mode: applying existing results ===')
        with open(RESULTS_FILE, encoding='utf-8') as f:
            results = json.load(f)
        n = apply_fixes(results)
        print(f'Fixed {n} records.')
        return

    # Load communities
    with open(COMMUNITIES_FILE, encoding='utf-8') as f:
        data = json.load(f)
    communities = data['communities']
    print(f'Loaded {len(communities)} communities.')

    # Find candidates
    candidates = find_candidates(communities)
    print(f'Found {len(candidates)} candidates for geocoding.')

    by_reason = defaultdict(int)
    by_district = defaultdict(int)
    for c in candidates:
        by_reason[c['reason']] += 1
        by_district[c['district']] += 1
    print('By reason:', dict(by_reason))
    print('By district:', dict(sorted(by_district.items(), key=lambda x: -x[1])))

    # Save candidates
    with open(CANDIDATES_FILE, 'w', encoding='utf-8') as f:
        json.dump(candidates, f, ensure_ascii=False, indent=2)

    # Process in batches
    all_results = []
    BATCH_SIZE = args.batch_size

    for batch_start in range(0, len(candidates), BATCH_SIZE):
        batch = candidates[batch_start:batch_start + BATCH_SIZE]
        batch_end = min(batch_start + BATCH_SIZE, len(candidates))
        print(f'\nBatch {batch_start // BATCH_SIZE + 1}: [{batch_start+1}-{batch_end}]')

        batch_results = run_geocode_batch(batch)
        all_results.extend(batch_results)

        # Save intermediate
        with open(RESULTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)

        needs_fix_so_far = sum(1 for r in all_results if r.get('needs_fix'))
        print(f'  Batch done. Total: {len(all_results)}, needs fix so far: {needs_fix_so_far}')

        if batch_end < len(candidates):
            time.sleep(2)

    # Summary
    needs_fix = [r for r in all_results if r.get('needs_fix')]
    failed = [r for r in all_results if r.get('error')]
    print(f'\n=== Geocoding Summary ===')
    print(f'Total processed: {len(all_results)}')
    print(f'  Needs fix (>{FIX_THRESHOLD_M}m off): {len(needs_fix)}')
    print(f'  Geocode failed: {len(failed)}')
    print()

    needs_fix.sort(key=lambda x: -(x['distance_m'] or 0))
    print('Top 20 needing fix:')
    for r in needs_fix[:20]:
        print(
            f"  {r['district']:6s} {r['name']:25s}: {r['distance_m']}m  "
            f"[{r['current_lat']:.6f},{r['current_lng']:.6f}] -> "
            f"[{r['geocoder_lat']:.6f},{r['geocoder_lng']:.6f}]"
        )

    # Apply fixes
    print(f'\n=== Applying Fixes ===')
    fixed_count = apply_fixes(all_results)
    print(f'\nFixed {fixed_count} records in communities.json.')
    print(f'Results saved to {RESULTS_FILE}')


if __name__ == '__main__':
    main()
