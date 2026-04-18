"""
filter_commute_targets.py
筛选新漕河泾国际商务中心B座通勤圈内的小区，输出带 source_url 的目标列表。

用法：python3 scripts/filter_commute_targets.py [--radius 10]
输出：data/processed/commute_targets.json
"""

import json
import math
import sys
import os
from pathlib import Path

ROOT = Path(__file__).parent.parent

# 新漕河泾国际商务中心B座坐标（GCJ-02，闵行区漕宝路）
WORK_LNG = 121.4186
WORK_LAT = 31.1524
WORK_NAME = "新漕河泾国际商务中心B座"

def haversine_km(lat1, lng1, lat2, lng2):
    """计算两点之间的球面距离（公里）"""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng/2)**2
    return R * 2 * math.asin(math.sqrt(a))

def main():
    # 解析参数
    radius_km = 10.0
    for i, arg in enumerate(sys.argv[1:]):
        if arg == '--radius' and i + 1 < len(sys.argv[1:]):
            radius_km = float(sys.argv[i + 2])

    # 读取小区数据
    comm_file = ROOT / 'data/processed/communities.json'
    with open(comm_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    communities = data['communities']
    print(f"总计 {len(communities)} 个小区")

    # 筛选有 source_url 且在半径内的小区
    targets = []
    no_url = 0
    for c in communities:
        if not c.get('source_url'):
            no_url += 1
            continue
        dist = haversine_km(WORK_LAT, WORK_LNG, c['lat'], c['lng'])
        if dist <= radius_km:
            targets.append({
                'id': c['id'],
                'name': c['name'],
                'district': c['district'],
                'subdistrict': c.get('subdistrict'),
                'lat': c['lat'],
                'lng': c['lng'],
                'avg_price': c.get('avg_price'),
                'source_url': c['source_url'],
                'dist_km': round(dist, 2),
            })

    targets.sort(key=lambda x: x['dist_km'])

    print(f"无 source_url: {no_url} 个")
    print(f"10km 圈内: {len(targets)} 个小区")

    # 区分布统计
    from collections import Counter
    dist_counter = Counter(t['district'] for t in targets)
    print("\n区分布：")
    for district, count in sorted(dist_counter.items(), key=lambda x: -x[1]):
        print(f"  {district}: {count}")

    # 输出
    out = {
        '_meta': {
            'work_location': WORK_NAME,
            'work_lng': WORK_LNG,
            'work_lat': WORK_LAT,
            'radius_km': radius_km,
            'total': len(targets),
            'generated_at': __import__('datetime').datetime.now().isoformat(),
        },
        'communities': targets,
    }

    out_file = ROOT / 'data/processed/commute_targets.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"\n输出: {out_file}")
    print(f"最近小区: {targets[0]['name']} ({targets[0]['dist_km']} km)")
    print(f"最远小区: {targets[-1]['name']} ({targets[-1]['dist_km']} km)")

if __name__ == '__main__':
    main()
