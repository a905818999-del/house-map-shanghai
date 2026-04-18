#!/usr/bin/env python3
"""
merge_ref_price.py
==================
将链家参考均价（fetch_lianjia_ref_price.mjs 输出）合并进 communities.json。

用法
----
    # 自动查找 data/raw/lianjia_ref_price_commute_*.json 并合并
    python scripts/merge_ref_price.py

    # 指定具体文件
    python scripts/merge_ref_price.py --ref data/raw/lianjia_ref_price_commute_targets_20260416.json

说明
----
- 以 source_url 为 key 精确匹配（不依赖小区名）
- 新增 ref_price 字段，保留原 avg_price 不变
- 合并后写回 communities.json
"""

import argparse
import json
import glob
import sys
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).parent.parent


def main():
    parser = argparse.ArgumentParser(description="合并链家参考均价到 communities.json")
    parser.add_argument("--ref", default=None, help="参考均价 JSON 文件路径（默认自动查找）")
    parser.add_argument("--communities", default=str(ROOT / "data/processed/communities.json"))
    args = parser.parse_args()

    # 查找参考均价文件
    if args.ref:
        files = [args.ref]
    else:
        pattern = str(ROOT / 'data/raw/lianjia_ref_price_commute_*.json')
        files = sorted(glob.glob(pattern))
        if not files:
            pattern2 = str(ROOT / 'data/raw/lianjia_ref_price_*.json')
            files = sorted(glob.glob(pattern2))

    if not files:
        sys.exit('未找到参考均价文件，请先运行 fetch_lianjia_ref_price.mjs')

    print(f'找到 {len(files)} 个参考均价文件:')
    for f in files:
        print(f'  {f}')

    # 加载参考均价，以 source_url 为 key
    ref_map = {}
    for fpath in files:
        with open(fpath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        for entry in data.get('ref_prices', []):
            url = entry.get('source_url')
            price = entry.get('ref_price')
            if url and price is not None:
                ref_map[url] = price

    print(f'加载参考均价: {len(ref_map)} 条')

    # 读取 communities.json
    comm_path = Path(args.communities)
    with open(comm_path, 'r', encoding='utf-8') as f:
        comm_data = json.load(f)

    communities = comm_data['communities']
    print(f'小区总数: {len(communities)}')

    # 合并
    updated = 0
    for c in communities:
        url = c.get('source_url', '')
        if url in ref_map:
            c['ref_price'] = ref_map[url]
            updated += 1
        elif 'ref_price' not in c:
            c['ref_price'] = None

    print(f'更新 ref_price: {updated} 个小区 ({updated/len(communities)*100:.1f}%)')

    comm_data['_meta']['ref_price_updated_at'] = datetime.now().isoformat()
    comm_data['_meta']['ref_price_count'] = updated

    with open(comm_path, 'w', encoding='utf-8') as f:
        json.dump(comm_data, f, ensure_ascii=False, separators=(',', ':'))

    print(f'已写入: {comm_path}')


if __name__ == "__main__":
    main()
