"""
用 Playwright 加载本地 app 页面（已有高德 API），批量 geocode 坐标可疑记录。
每条记录单独 evaluate，失败重试，不依赖 set_content。
"""
import json, math, sys, time, argparse
from pathlib import Path
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

COMMUNITIES_FILE = Path(__file__).parent.parent / 'data/processed/communities.json'
RESULTS_FILE = Path(__file__).parent.parent / 'data/processed/geocode_results.json'
APP_URL = 'http://localhost:8900/src/'
FIX_THRESHOLD_M = 800
DEFAULT_COORD = (31.235929, 121.480539)

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


def haversine(lat1, lng1, lat2, lng2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlng/2)**2)
    return R * 2 * math.asin(math.sqrt(a))


def find_candidates(communities):
    candidates, seen = [], set()
    for c in communities:
        if c['name'] in seen:
            continue
        lat, lng = c['lat'], c['lng']
        district = c.get('district', '')
        reason = None
        if abs(lat - DEFAULT_COORD[0]) < 1e-6 and abs(lng - DEFAULT_COORD[1]) < 1e-6:
            reason = 'default_coord'
        elif district in DISTRICT_STRICT_BOUNDS:
            la, lb, ga, gb = DISTRICT_STRICT_BOUNDS[district]
            if not (la <= lat <= lb and ga <= lng <= gb):
                reason = 'outside_district'
        if reason:
            candidates.append({'name': c['name'], 'district': district, 'lat': lat, 'lng': lng, 'reason': reason})
            seen.add(c['name'])
    return candidates


GEOCODE_JS = """
async (name) => {
    if (typeof AMap === 'undefined') return {ok: false, err: 'AMap not loaded'};
    if (typeof AMap.Geocoder === 'undefined') {
        await new Promise((resolve, reject) => {
            AMap.plugin('AMap.Geocoder', resolve);
            setTimeout(() => reject('plugin timeout'), 5000);
        });
    }
    return new Promise((resolve) => {
        const gc = new AMap.Geocoder({city: '上海', limit: 1});
        const timer = setTimeout(() => resolve({ok: false, err: 'timeout'}), 8000);
        gc.getLocation(name, (status, res) => {
            clearTimeout(timer);
            if (status === 'complete' && res.geocodes && res.geocodes.length > 0) {
                const loc = res.geocodes[0].location;
                resolve({ok: true, lat: loc.lat, lng: loc.lng});
            } else {
                resolve({ok: false, err: status});
            }
        });
    });
}
"""


def wait_for_amap(page, timeout=20000):
    page.wait_for_function('() => typeof AMap !== "undefined"', timeout=timeout)


def geocode_one(page, name, retries=2):
    for attempt in range(retries):
        try:
            result = page.evaluate(GEOCODE_JS, name)
            return result
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(1)
            else:
                return {'ok': False, 'err': str(e)}


def load_existing_results():
    if RESULTS_FILE.exists():
        with open(RESULTS_FILE, encoding='utf-8') as f:
            results = json.load(f)
        return {r['name']: r for r in results}
    return {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply-only', action='store_true')
    parser.add_argument('--limit', type=int, default=0, help='Process only N candidates (0=all)')
    args = parser.parse_args()

    with open(COMMUNITIES_FILE, encoding='utf-8') as f:
        data = json.load(f)
    communities = data['communities']
    print(f'Loaded {len(communities)} communities.')

    if args.apply_only:
        existing = load_existing_results()
        fix_map = {n: r for n, r in existing.items() if r.get('needs_fix') and r.get('geo_lat')}
        print(f'Applying {len(fix_map)} fixes from {RESULTS_FILE}')
        _apply_fixes(data, fix_map)
        return

    candidates = find_candidates(communities)
    print(f'Found {len(candidates)} candidates.')
    by_reason = defaultdict(int)
    for c in candidates: by_reason[c['reason']] += 1
    print('By reason:', dict(by_reason))

    if args.limit:
        candidates = candidates[:args.limit]
        print(f'Limited to {len(candidates)} candidates.')

    # Resume from existing results
    existing = load_existing_results()
    todo = [c for c in candidates if c['name'] not in existing]
    print(f'Already done: {len(existing)}, remaining: {len(todo)}')

    from playwright.sync_api import sync_playwright
    all_results = dict(existing)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-proxy-server'])
        page = browser.new_page()

        print(f'Loading {APP_URL}...')
        page.goto(APP_URL, wait_until='domcontentloaded', timeout=30000)
        wait_for_amap(page)
        print('AMap ready.')

        for i, cand in enumerate(todo):
            name = cand['name']
            district = cand.get('district', '')
            cur_lat, cur_lng = cand['lat'], cand['lng']

            print(f'[{len(existing)+i+1}/{len(candidates)}] {district} {name}...', end=' ', flush=True)
            result = geocode_one(page, name)

            if result and result.get('ok'):
                geo_lat, geo_lng = result['lat'], result['lng']
                dist = haversine(cur_lat, cur_lng, geo_lat, geo_lng)
                needs_fix = dist > FIX_THRESHOLD_M
                flag = '*** FIX ***' if needs_fix else 'ok'
                print(f'{dist:.0f}m {flag}')
                all_results[name] = {
                    'name': name, 'district': district,
                    'current_lat': cur_lat, 'current_lng': cur_lng,
                    'geo_lat': geo_lat, 'geo_lng': geo_lng,
                    'dist_m': round(dist), 'needs_fix': needs_fix,
                    'reason': cand['reason'],
                }
            else:
                err = result.get('err', 'unknown') if result else 'no result'
                print(f'FAILED ({err})')
                all_results[name] = {
                    'name': name, 'district': district,
                    'current_lat': cur_lat, 'current_lng': cur_lng,
                    'geo_lat': None, 'geo_lng': None,
                    'dist_m': None, 'needs_fix': False, 'error': err,
                    'reason': cand['reason'],
                }

            # Save every 20
            if (i + 1) % 20 == 0:
                _save_results(all_results)
                print(f'  [checkpoint saved, {i+1} done]')

            time.sleep(0.3)

        browser.close()

    _save_results(all_results)

    # Summary
    results_list = list(all_results.values())
    needs_fix = [r for r in results_list if r.get('needs_fix')]
    failed = [r for r in results_list if r.get('error')]
    print(f'\n=== Summary ===')
    print(f'Total: {len(results_list)}, needs fix: {len(needs_fix)}, failed: {len(failed)}')

    needs_fix.sort(key=lambda x: -(x['dist_m'] or 0))
    print('Top 20 needing fix:')
    for r in needs_fix[:20]:
        print(f"  {r['district']:6s} {r['name']:25s}: {r['dist_m']}m")

    fix_map = {r['name']: r for r in needs_fix}
    _apply_fixes(data, fix_map)


def _save_results(all_results):
    with open(RESULTS_FILE, 'w', encoding='utf-8') as f:
        json.dump(list(all_results.values()), f, ensure_ascii=False, indent=2)


def _apply_fixes(data, fix_map):
    if not fix_map:
        print('No fixes to apply.')
        return 0
    fixed = 0
    for c in data['communities']:
        if c['name'] in fix_map:
            r = fix_map[c['name']]
            print(f"  Fix {c.get('district','')} {c['name']}: ({c['lat']:.5f},{c['lng']:.5f}) -> ({r['geo_lat']:.5f},{r['geo_lng']:.5f}) {r['dist_m']}m")
            c['lat'] = r['geo_lat']
            c['lng'] = r['geo_lng']
            fixed += 1
    with open(COMMUNITIES_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Fixed {fixed} records in communities.json.')
    return fixed


if __name__ == '__main__':
    main()
