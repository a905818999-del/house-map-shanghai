#!/usr/bin/env python3
"""
merge_ref_price.py
==================
将外部参考均价数据（链家成交价 / WorkBuddy 抓取）合并进 communities.json。

用法
----
    python scripts/merge_ref_price.py \
        --communities data/processed/communities.json \
        --ref         data/ref_prices.csv \
        --output      data/processed/communities.json

ref_prices.csv 格式（UTF-8，含表头）
-------------------------------------
    name,ref_price
    "世茂滨江花园",85000
    "中远两湾城",62000
    ...

说明
----
- 按小区名精确匹配；匹配不到的小区不修改 avg_price。
- 若原 avg_price 为 null（暂无数据），用 ref_price 填入。
- 若原 avg_price 已有值，ref_price 将覆盖（可通过 --no-overwrite 关闭）。
- 合并后写回 JSON，保留所有其他字段。
"""

import argparse
import csv
import json
import sys
from pathlib import Path


def load_ref_prices(ref_path: Path) -> dict[str, float]:
    """读取参考均价 CSV，返回 {name: price} 字典。"""
    prices: dict[str, float] = {}
    with open(ref_path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if "name" not in (reader.fieldnames or []) or "ref_price" not in (reader.fieldnames or []):
            sys.exit("CSV 必须包含 'name' 和 'ref_price' 列")
        for row in reader:
            name = row["name"].strip()
            try:
                price = float(row["ref_price"])
            except (ValueError, TypeError):
                print(f"[warn] 跳过无效价格行: {row}", file=sys.stderr)
                continue
            prices[name] = price
    return prices


def merge(communities: list[dict], ref_prices: dict[str, float], overwrite: bool) -> tuple[int, int]:
    """原地合并，返回 (matched, updated)。"""
    matched = updated = 0
    for c in communities:
        name = c.get("name", "")
        if name in ref_prices:
            matched += 1
            ref = ref_prices[name]
            if c.get("avg_price") is None or overwrite:
                c["avg_price"] = ref
                updated += 1
    return matched, updated


def main():
    parser = argparse.ArgumentParser(description="合并参考均价到 communities.json")
    parser.add_argument("--communities", default="data/processed/communities.json",
                        help="输入 communities.json 路径")
    parser.add_argument("--ref", required=True,
                        help="参考均价 CSV 路径（含 name, ref_price 列）")
    parser.add_argument("--output", default=None,
                        help="输出路径（默认覆盖 --communities）")
    parser.add_argument("--no-overwrite", action="store_true",
                        help="仅填充 avg_price 为 null 的记录，已有值的不覆盖")
    args = parser.parse_args()

    comm_path = Path(args.communities)
    ref_path = Path(args.ref)
    out_path = Path(args.output) if args.output else comm_path

    if not comm_path.exists():
        sys.exit(f"找不到 communities.json: {comm_path}")
    if not ref_path.exists():
        sys.exit(f"找不到参考均价 CSV: {ref_path}")

    print(f"加载 {comm_path} …")
    with open(comm_path, encoding="utf-8") as f:
        data = json.load(f)

    # 兼容两种结构：列表 或 {"communities": [...]}
    communities = data if isinstance(data, list) else data.get("communities", data)

    print(f"加载参考均价 {ref_path} …")
    ref_prices = load_ref_prices(ref_path)
    print(f"  参考均价记录: {len(ref_prices)} 条")

    overwrite = not args.no_overwrite
    matched, updated = merge(communities, ref_prices, overwrite)

    print(f"  匹配小区: {matched} 个 | 更新 avg_price: {updated} 个")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"已写出 → {out_path}")


if __name__ == "__main__":
    main()
