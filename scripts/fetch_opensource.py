#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
"""
拉取开源上海房价数据集，立即得到真实数据（无需等待爬虫）

支持两个数据源：
  A. WxxW2002/Spider (2023, MIT, 42,982 条挂牌含坐标+建造年份)
  B. likkhello/shanghai_lianjia_house_price (2016, 14,363 个小区聚合)

用法：
  python scripts/fetch_opensource.py            # 下载 A+B，合并处理
  python scripts/fetch_opensource.py --a-only   # 只下载 WxxW2002
  python scripts/fetch_opensource.py --b-only   # 只下载 likkhello
  python scripts/fetch_opensource.py --changning-minhang  # 只保留长宁+闵行
"""

import sys
import os
import urllib.request
import urllib.error
import shutil
from pathlib import Path

ROOT = Path(__file__).parent.parent
RAW_DIR = ROOT / "data" / "raw"

# 数据源 URL（GitHub raw）
WXXW_CSV_URL = (
    "https://raw.githubusercontent.com/WxxW2002/Spider/main/Spider/data/data_with_coordinates.csv"
)
LIKKHELLO_JSON_URL = (
    "https://raw.githubusercontent.com/likkhello/shanghai_lianjia_house_price/master/data/lianjia_shanghai_communities.json"
)


def download(url, dest, label):
    dest = Path(dest)
    if dest.exists():
        print(f"[已存在] {dest.name}，跳过下载")
        return True

    print(f"[下载] {label}")
    print(f"  → {url}")
    print(f"  → {dest}")

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp, \
             open(dest, "wb") as f:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            chunk = 65536
            while True:
                block = resp.read(chunk)
                if not block:
                    break
                f.write(block)
                downloaded += len(block)
                if total:
                    pct = downloaded * 100 // total
                    print(f"\r  进度: {pct}% ({downloaded//1024} KB)", end="", flush=True)
            print()
        print(f"  ✓ 完成 ({dest.stat().st_size // 1024} KB)")
        return True
    except urllib.error.URLError as e:
        print(f"  ✗ 下载失败: {e}")
        return False
    except Exception as e:
        print(f"  ✗ 错误: {e}")
        return False


def run_process(files, extra_args=""):
    """调用 process.py 清洗数据"""
    import subprocess
    cmd = [sys.executable, str(ROOT / "scripts" / "process.py")] + files
    if extra_args:
        cmd.extend(extra_args.split())
    print(f"\n[清洗] 运行 process.py ...")
    result = subprocess.run(cmd, cwd=str(ROOT))
    return result.returncode == 0


def main():
    args = sys.argv[1:]
    a_only = "--a-only" in args
    b_only = "--b-only" in args
    filter_districts = "--changning-minhang" in args

    RAW_DIR.mkdir(parents=True, exist_ok=True)

    downloaded = []

    # ── Source A: WxxW2002 CSV ──────────────────────────────────────────────
    if not b_only:
        dest_a = RAW_DIR / "wxxw2002_spider_2023.csv"
        ok = download(WXXW_CSV_URL, dest_a, "WxxW2002/Spider (2023, MIT, 42K条上海挂牌)")
        if ok:
            downloaded.append(str(dest_a))
        else:
            print("[提示] 下载 WxxW2002 失败，请手动下载：")
            print(f"  {WXXW_CSV_URL}")
            print(f"  保存到: {dest_a}")

    # ── Source B: likkhello JSON ────────────────────────────────────────────
    if not a_only:
        dest_b = RAW_DIR / "likkhello_communities_2016.json"
        ok = download(LIKKHELLO_JSON_URL, dest_b, "likkhello (2016, 14K小区聚合)")
        if ok:
            downloaded.append(str(dest_b))
        else:
            print("[提示] 下载 likkhello 失败，请手动下载：")
            print(f"  {LIKKHELLO_JSON_URL}")
            print(f"  保存到: {dest_b}")

    if not downloaded:
        print("\n✗ 所有下载均失败，请检查网络或手动下载")
        sys.exit(1)

    # ── 清洗处理 ────────────────────────────────────────────────────────────
    ok = run_process(downloaded)
    if ok:
        print(f"\n✓ 数据就绪: {ROOT / 'data' / 'processed' / 'communities.json'}")
        print("  现在启动地图即可看到真实数据！")
        if filter_districts:
            _filter_districts(["长宁区", "闵行区"])
    else:
        print("\n✗ 数据清洗失败，请检查 scripts/process.py 报错")
        sys.exit(1)


def _filter_districts(districts):
    """过滤只保留指定行政区（调试/演示用）"""
    from datetime import datetime
    import json

    out_file = ROOT / "data" / "processed" / "communities.json"
    with open(out_file, encoding="utf-8") as f:
        data = json.load(f)

    original = data["communities"]
    filtered = [c for c in original if c.get("district") in districts]
    data["communities"] = filtered
    data["_meta"]["total"] = len(filtered)
    data["_meta"]["filter_note"] = f"已过滤，只保留: {', '.join(districts)}"

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"  [过滤] 保留 {len(filtered)} / {len(original)} 个小区 ({', '.join(districts)})")


if __name__ == "__main__":
    main()
