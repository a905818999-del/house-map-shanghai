"""
用 Nominatim (OSM) HTTP API 批量验证并修复 communities.json 坐标可疑记录。
Nominatim 返回 WGS84，用 gcj02 转换函数转为高德 GCJ-02 再与现有坐标对比。

注意：仅修复偏差极大（>1000m after 坐标系补偿）的记录，避免引入新误差。
"""
import json
import math
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path
from collections import defaultdict

sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)

COMMUNITIES_FILE = Path(__file__).parent.parent / 'data/processed/communities.json'
RESULTS_FILE = Path(__file__).parent.parent / 'data/processed/geocode_results.json'

FIX_THRESHOLD_M = 1500  # 更保守：>1500m 才修

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
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlng / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


# WGS84 -> GCJ02 conversion (China coordinate offset)
def _transform_lat(lng, lat):
    ret = -100.0 + 2.0*lng + 3.0*lat + 0.2*lat*lat + 0.1*lng*lat + 0.2*math.sqrt(abs(lng))
    ret += (20.0*math.sin(6.0*lng*math.pi) + 20.0*math.sin(2.0*lng*math.pi)) * 2.0/3.0
    ret += (20.0*math.sin(lat*math.pi) + 40.0*math.sin(lat/3.0*math.pi)) * 2.0/3.0
    ret += (160.0*math.sin(lat/12.0*math.pi) + 320.0*math.sin(lat*math.pi/30.0)) * 2.0/3.0
    return ret

def _transform_lng(lng, lat):
    ret = 300.0 + lng + 2.0*lat + 0.1*lng*lng + 0.1*lng*lat + 0.1*math.sqrt(abs(lng))
    ret += (20.0*math.sin(6.0*lng*math.pi) + 20.0*math.sin(2.0*lng*math.pi)) * 2.0/3.0
    ret += (20.0*math.sin(lng*math.pi) + 40.0*math.sin(lng/3.0*math.pi)) * 2.0/3.0
    ret += (150.0*math.sin(lng/12.0*math.pi) + 300.0*math.sin(lng/30.0*math.pi)) * 2.0/3.0
    return ret

def wgs84_to_gcj02(lat, lng):
    a = 6378245.0
    ee = 0.00669342162296594323
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - ee * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (a / sqrtmagic * math.cos(radlat) * math.pi)
    return lat + dlat, lng + dlng


def nominatim_geocode(name, district='上海'):
    """Query Nominatim for a place name, return (lat_gcj, lng_gcj) or None."""
    query = f'{name}, {district}, 上海, 中国'
    params = urllib.parse.urlencode({
        'q': query,
        'format': 'json',
        'limit': 1,
        'countrycodes': 'cn',
        'viewbox': '120.8,30.6,122.2,31.9',
        'bounded': 1,
    })
    url = f'https://nominatim.openstreetmap.org/search?{params}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'house-map-geocode/1.0 (coordinate-validation)',
        'Accept-Language': 'zh-CN,zh',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode('utf-8'))
        if data:
            wlat = float(data[0]['lat'])
            wlng = float(data[0]['lon'])
            # Convert WGS84 -> GCJ02
            glat, glng = wgs84_to_gcj02(wlat, wlng)
            return glat, glng
    except Exception as e:
        print(f'    Nominatim error: {e}')
    return None


def find_candidates(communities):
    candidates = []
    seen = set()
    for c in communities:
        if c['name'] in seen:
            continue
        lat, lng = c['lat'], c['lng']
        district = c.get('district', '')
        reason = None

        if abs(lat - DEFAULT_COORD[0]) < 0.000001 and abs(lng - DEFAULT_COORD[1]) < 0.000001:
            reason = 'default_coord'
        elif district in DISTRICT_STRICT_BOUNDS:
            lat_min, lat_max, lng_min, lng_max = DISTRICT_STRICT_BOUNDS[district]
            if not (lat_min <= lat <= lat_max and lng_min <= lng <= lng_max):
                reason = 'outside_district'

        if reason:
            candidates.append({
                'name': c['name'], 'district': district,
                'lat': lat, 'lng': lng, 'reason': reason,
            })
            seen.add(c['name'])
    return candidates


def main():
    with open(COMMUNITIES_FILE, encoding='utf-8') as f:
        data = json.load(f)
    communities = data['communities']
    print(f'Loaded {len(communities)} communities.')

    candidates = find_candidates(communities)
    print(f'Found {len(candidates)} candidates.')
    by_reason = defaultdict(int)
    for c in candidates:
        by_reason[c['reason']] += 1
    print('By reason:', dict(by_reason))

    results = []
    fixes_applied = 0

    for i, cand in enumerate(candidates):
        name = cand['name']
        district = cand.get('district', '')
        cur_lat, cur_lng = cand['lat'], cand['lng']

        print(f'[{i+1}/{len(candidates)}] {district} {name}...', end=' ', flush=True)
        geo = nominatim_geocode(name, district)

        if geo is None:
            print('FAILED')
            results.append({'name': name, 'district': district,
                            'current_lat': cur_lat, 'current_lng': cur_lng,
                            'geo_lat': None, 'geo_lng': None,
                            'dist_m': None, 'fixed': False, 'error': 'geocode_failed'})
        else:
            geo_lat, geo_lng = geo
            dist = haversine(cur_lat, cur_lng, geo_lat, geo_lng)
            needs_fix = dist > FIX_THRESHOLD_M
            print(f'{dist:.0f}m {"*** FIX ***" if needs_fix else "ok"}')
            results.append({'name': name, 'district': district,
                            'current_lat': cur_lat, 'current_lng': cur_lng,
                            'geo_lat': geo_lat, 'geo_lng': geo_lng,
                            'dist_m': round(dist), 'fixed': needs_fix})

        # Save intermediate results
        if (i + 1) % 10 == 0:
            with open(RESULTS_FILE, 'w', encoding='utf-8') as f:
                json.dump(results, f, ensure_ascii=False, indent=2)

        time.sleep(1.1)  # Nominatim rate limit: max 1 req/s

    # Final save
    with open(RESULTS_FILE, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    # Build fix map
    fix_map = {r['name']: r for r in results if r.get('fixed') and r.get('geo_lat')}
    print(f'\n=== Summary ===')
    print(f'Total: {len(results)}, need fix: {len(fix_map)}, failed: {sum(1 for r in results if r.get("error"))}')

    if not fix_map:
        print('No fixes to apply.')
        return

    print('\nTop fixes:')
    for r in sorted(fix_map.values(), key=lambda x: -(x['dist_m'] or 0))[:20]:
        print(f"  {r['district']:6s} {r['name']:25s}: {r['dist_m']}m")

    # Apply fixes
    print('\nApplying fixes...')
    for c in data['communities']:
        if c['name'] in fix_map:
            r = fix_map[c['name']]
            print(f"  {c['district']} {c['name']}: [{c['lat']:.6f},{c['lng']:.6f}] -> [{r['geo_lat']:.6f},{r['geo_lng']:.6f}]")
            c['lat'] = r['geo_lat']
            c['lng'] = r['geo_lng']
            fixes_applied += 1

    with open(COMMUNITIES_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    print(f'\nFixed {fixes_applied} records in communities.json.')


if __name__ == '__main__':
    main()
