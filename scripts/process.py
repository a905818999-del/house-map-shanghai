#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
"""
数据清洗管道：raw → processed/communities.json
支持三种输入格式：
  1. WorkBuddy 输出（data/raw/lianjia_*.json）
  2. WxxW2002/Spider CSV（data_with_coordinates.csv，挂牌级 → 聚合）
  3. likkhello JSON（lianjia_shanghai_communities.json，小区级）

用法：
  python scripts/process.py                  # 处理 data/raw/ 下所有文件
  python scripts/process.py path/to/file     # 处理指定文件
  python scripts/process.py --validate-only  # 只做校验，不写输出
"""

import json
import csv
import sys
import os
import glob
import re
from datetime import datetime
from pathlib import Path
from collections import defaultdict
import math

# ── 路径配置 ───────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_FILE = ROOT / "data" / "processed" / "communities.json"

# 上海坐标边界（GCJ-02）
LAT_MIN, LAT_MAX = 30.7, 31.9
LNG_MIN, LNG_MAX = 120.8, 122.2

# 合理的均价范围（元/m²）
PRICE_MIN, PRICE_MAX = 5000, 500000

# 合理的建成年份范围
YEAR_MIN, YEAR_MAX = 1950, 2025


# ── WGS-84 → GCJ-02 坐标转换 ─────────────────────────────────────────────────
# 链家/Spider 数据坐标可能是 WGS-84，高德底图是 GCJ-02，不转会偏移几百米

_A = 6378245.0
_EE = 0.00669342162296594

def _out_of_china(lat, lng):
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)

def _transform_lat(x, y):
    ret = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
    ret += (20.0*math.sin(6.0*x*math.pi) + 20.0*math.sin(2.0*x*math.pi)) * 2.0 / 3.0
    ret += (20.0*math.sin(y*math.pi) + 40.0*math.sin(y/3.0*math.pi)) * 2.0 / 3.0
    ret += (160.0*math.sin(y/12.0*math.pi) + 320.0*math.sin(y*math.pi/30.0)) * 2.0 / 3.0
    return ret

def _transform_lng(x, y):
    ret = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
    ret += (20.0*math.sin(6.0*x*math.pi) + 20.0*math.sin(2.0*x*math.pi)) * 2.0 / 3.0
    ret += (20.0*math.sin(x*math.pi) + 40.0*math.sin(x/3.0*math.pi)) * 2.0 / 3.0
    ret += (150.0*math.sin(x/12.0*math.pi) + 300.0*math.sin(x/30.0*math.pi)) * 2.0 / 3.0
    return ret

def wgs84_to_gcj02(lat, lng):
    """WGS-84 → GCJ-02（火星坐标）"""
    if _out_of_china(lat, lng):
        return lat, lng
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - _EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (_A / sqrtmagic * math.cos(radlat) * math.pi)
    return round(lat + dlat, 6), round(lng + dlng, 6)


# ── 工具函数 ───────────────────────────────────────────────────────────────────

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def warn(msg):
    print(f"[WARN] {msg}", file=sys.stderr)


def validate_community(c, source_hint=""):
    """校验单条小区数据，返回 (ok: bool, errors: list)"""
    errors = []

    # 必填字段
    if not c.get("name"):
        errors.append("缺少 name")
    if not c.get("district"):
        errors.append("缺少 district")

    # 坐标
    lat, lng = c.get("lat"), c.get("lng")
    if lat is None or lng is None:
        errors.append("缺少 lat/lng")
    elif not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
        errors.append(f"坐标超出上海范围: lat={lat}, lng={lng}")

    # 价格（允许 null，但有值时校验）
    price = c.get("avg_price")
    if price is not None:
        if not (PRICE_MIN <= price <= PRICE_MAX):
            errors.append(f"avg_price 异常: {price} 元/m²")
        # 常见错误：单位是万元而不是元
        if price < 1000:
            errors.append(f"avg_price 可能单位错误（{price}），应为元/m²")

    # 建成年份
    year = c.get("build_year")
    if year is not None and not (YEAR_MIN <= year <= YEAR_MAX):
        errors.append(f"build_year 超出范围: {year}")

    return len(errors) == 0, errors


def dedup(communities):
    """按 (name, district) 去重，保留均价/年份更完整的那条"""
    seen = {}
    for c in communities:
        key = (c.get("name", "").strip(), c.get("district", "").strip())
        if key not in seen:
            seen[key] = c
        else:
            existing = seen[key]
            # 用信息更全的覆盖
            if existing.get("avg_price") is None and c.get("avg_price") is not None:
                seen[key] = c
            elif existing.get("build_year") is None and c.get("build_year") is not None:
                seen[key]["build_year"] = c["build_year"]
    return list(seen.values())


# ── 格式 1：WorkBuddy raw JSON ─────────────────────────────────────────────────

def load_workbuddy_json(path):
    """加载 WorkBuddy 输出的标准 JSON 格式"""
    log(f"读取 WorkBuddy JSON: {path}")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    communities = data.get("communities", [])
    log(f"  原始记录: {len(communities)}")
    return communities


# ── 格式 2：WxxW2002/Spider CSV（挂牌级 → 聚合到小区级）────────────────────────

def load_wxxw2002_csv(path):
    """
    CSV 字段（实际列名）：
    URL, Title, Subtitle, Total, Average, District, Community, Community URL,
    House Type, Floor, Area, House Structure, Building Type, Orientation,
    Building Structure, Decoration Degree, Ladder Ratio, Has Elevator,
    Build Time, Housing Age, Community Address, Total Buildings, Total Houses,
    Average Property Cost, Latitude, Longitude
    """
    log(f"读取 WxxW2002 CSV: {path}")
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    log(f"  原始挂牌条数: {len(rows)}")

    # 按小区聚合
    by_community = defaultdict(list)
    for row in rows:
        name = row.get("Community", "").strip()
        district = row.get("District", "").strip()
        if name and district:
            by_community[(name, district)].append(row)

    communities = []
    for (name, district), listings in by_community.items():
        # 价格：取均值（过滤异常值）
        prices = []
        for r in listings:
            try:
                p = float(r.get("Average", "").replace(",", ""))
                if PRICE_MIN <= p <= PRICE_MAX:
                    prices.append(p)
            except (ValueError, AttributeError):
                pass

        # 建成年份：取众数
        years = []
        for r in listings:
            try:
                bt = r.get("Build Time", "").strip()
                # 格式可能是 "2003年" 或 "2003" 或 "2003-01-01"
                m = re.search(r"(19|20)\d{2}", bt)
                if m:
                    y = int(m.group())
                    if YEAR_MIN <= y <= YEAR_MAX:
                        years.append(y)
            except (ValueError, AttributeError):
                pass

        # 坐标（所有 listing 的均值，因为同小区坐标应一致）
        lats, lngs = [], []
        for r in listings:
            try:
                lat = float(r.get("Latitude", ""))
                lng = float(r.get("Longitude", ""))
                if LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX:
                    lats.append(lat)
                    lngs.append(lng)
            except (ValueError, AttributeError):
                pass

        if not lats:
            continue  # 没有坐标，跳过

        # 楼栋/总套数（取第一条有效值）
        total_buildings = None
        total_units = None
        for r in listings:
            try:
                tb = r.get("Total Buildings", "").strip()
                if tb and tb.isdigit():
                    total_buildings = int(tb)
                    break
            except (AttributeError, ValueError):
                pass
        for r in listings:
            try:
                th = r.get("Total Houses", "").strip()
                if th and th.isdigit():
                    total_units = int(th)
                    break
            except (AttributeError, ValueError):
                pass

        # 来源 URL
        source_url = ""
        for r in listings:
            u = r.get("Community URL", "").strip()
            if u:
                source_url = u
                break

        c = {
            "id": f"spider_{name}_{district}",
            "name": name,
            "district": _normalize_district(district),
            "subdistrict": None,
            "lat": round(sum(lats) / len(lats), 6),
            "lng": round(sum(lngs) / len(lngs), 6),
            "avg_price": round(sum(prices) / len(prices)) if prices else None,
            "build_year": max(set(years), key=years.count) if years else None,
            "total_buildings": total_buildings,
            "total_units": total_units,
            "source": "wxxw2002_spider",
            "source_url": source_url,
        }
        communities.append(c)

    log(f"  聚合后小区数: {len(communities)}")
    return communities


# ── 格式 3：likkhello JSON ────────────────────────────────────────────────────

def load_likkhello_json(path):
    """
    字段：_id, community_name, lat, lng, avr_price, age, building_count, house_count
    age = 相对2016年的房龄（年），build_year = 2016 - age
    """
    log(f"读取 likkhello JSON: {path}")
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)

    # 支持数组或带 communities 键
    if isinstance(raw, list):
        items = raw
    else:
        items = raw.get("communities", raw.get("data", []))

    log(f"  原始记录: {len(items)}")
    communities = []
    for item in items:
        lat = item.get("lat")
        lng = item.get("lng")
        if lat is None or lng is None:
            continue

        price = item.get("avr_price")
        if price == 0 or price == -1:
            price = None

        age = item.get("age", -1)
        build_year = (2016 - int(age)) if age and age > 0 else None
        if build_year and not (YEAR_MIN <= build_year <= YEAR_MAX):
            build_year = None

        c = {
            "id": f"likkhello_{item.get('_id', {}).get('$oid', '') or item.get('id', '')}",
            "name": item.get("community_name", "").strip(),
            "district": None,  # likkhello 没有 district 字段，靠坐标推断
            "subdistrict": None,
            "lat": round(float(lat), 6),
            "lng": round(float(lng), 6),
            "avg_price": int(price) if price else None,
            "build_year": build_year,
            "total_buildings": item.get("building_count") or None,
            "total_units": item.get("house_count") or None,
            "source": "likkhello",
            "source_url": "",
        }
        if c["name"]:
            communities.append(c)

    log(f"  有效记录: {len(communities)}")
    return communities


# ── 工具：district 标准化 ──────────────────────────────────────────────────────

DISTRICT_ALIASES = {
    "浦东": "浦东新区", "pudong": "浦东新区",
    "闵行": "闵行区", "minhang": "闵行区",
    "宝山": "宝山区", "baoshan": "宝山区",
    "嘉定": "嘉定区", "jiading": "嘉定区",
    "松江": "松江区", "songjiang": "松江区",
    "青浦": "青浦区", "qingpu": "青浦区",
    "奉贤": "奉贤区", "fengxian": "奉贤区",
    "金山": "金山区", "jinshan": "金山区",
    "黄浦": "黄浦区", "huangpu": "黄浦区",
    "静安": "静安区", "jingan": "静安区", "jing_an": "静安区",
    "徐汇": "徐汇区", "xuhui": "徐汇区",
    "长宁": "长宁区", "changning": "长宁区",
    "普陀": "普陀区", "putuo": "普陀区",
    "虹口": "虹口区", "hongkou": "虹口区",
    "杨浦": "杨浦区", "yangpu": "杨浦区",
    "崇明": "崇明区", "chongming": "崇明区",
}

def _normalize_district(d):
    if not d:
        return None
    d = d.strip()
    if d in DISTRICT_ALIASES:
        return DISTRICT_ALIASES[d]
    # 已经是标准形式（含「区」）
    if d.endswith("区") or d.endswith("新区"):
        return d
    return DISTRICT_ALIASES.get(d, d)


# ── 自动检测文件格式 ───────────────────────────────────────────────────────────

def detect_and_load(path):
    path = Path(path)
    suffix = path.suffix.lower()
    name = path.name.lower()

    if suffix == ".csv":
        return load_wxxw2002_csv(path)

    if suffix == ".json":
        with open(path, encoding="utf-8") as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError as e:
                warn(f"{path}: JSON 解析失败 — {e}")
                return []

        # likkhello 格式特征：有 community_name / avr_price / age 字段
        sample = data[0] if isinstance(data, list) and data else \
                 (data.get("communities") or [{}])[0] if isinstance(data, dict) else {}
        if "community_name" in sample or "avr_price" in sample:
            return load_likkhello_json(path)

        # WorkBuddy 格式特征：有 _meta.crawler 或 _meta.source
        if isinstance(data, dict) and "_meta" in data:
            return load_workbuddy_json(path)

        # 兜底：尝试 WorkBuddy 格式
        log(f"  未能识别格式，尝试 WorkBuddy 格式: {path.name}")
        return load_workbuddy_json(path)

    warn(f"不支持的文件格式: {path}")
    return []


# ── 主流程 ─────────────────────────────────────────────────────────────────────

def main():
    validate_only = "--validate-only" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]

    # 收集输入文件
    if args:
        files = args
    else:
        files = sorted(glob.glob(str(RAW_DIR / "*.json")) +
                       glob.glob(str(RAW_DIR / "*.csv")))
        if not files:
            log("data/raw/ 下没有文件，使用 mock 数据")
            files = [str(ROOT / "data" / "processed" / "communities.json")]

    log(f"=== 数据清洗管道启动 ===")
    log(f"输入文件: {len(files)} 个")

    all_communities = []
    for f in files:
        communities = detect_and_load(f)
        all_communities.extend(communities)

    log(f"合并后总记录: {len(all_communities)}")

    # 坐标校验 & 过滤
    valid = []
    invalid_count = 0
    for c in all_communities:
        ok, errors = validate_community(c)
        if ok:
            valid.append(c)
        else:
            invalid_count += 1
            warn(f"跳过 [{c.get('name', '?')}]: {'; '.join(errors)}")

    log(f"校验通过: {len(valid)}，跳过: {invalid_count}")

    # 去重
    deduped = dedup(valid)
    log(f"去重后: {len(deduped)}")

    # district 标准化
    for c in deduped:
        c["district"] = _normalize_district(c.get("district")) or c.get("district")

    # WGS-84 → GCJ-02 坐标转换
    converted = 0
    for c in deduped:
        old_lat, old_lng = c["lat"], c["lng"]
        new_lat, new_lng = wgs84_to_gcj02(old_lat, old_lng)
        if abs(new_lat - old_lat) > 0.0001 or abs(new_lng - old_lng) > 0.0001:
            converted += 1
        c["lat"] = new_lat
        c["lng"] = new_lng
    log(f"坐标转换 WGS-84→GCJ-02: {converted} 个有显著偏移")

    # 统计
    with_price = sum(1 for c in deduped if c.get("avg_price"))
    with_year  = sum(1 for c in deduped if c.get("build_year"))
    log(f"有均价: {with_price} ({with_price*100//len(deduped) if deduped else 0}%)，"
        f"有建成年份: {with_year} ({with_year*100//len(deduped) if deduped else 0}%)")

    if validate_only:
        log("=== 仅校验模式，不写入文件 ===")
        return

    # 写入
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    output = {
        "_meta": {
            "description": "上海小区房价+楼龄数据",
            "schema_version": "1.0",
            "source": "processed",
            "last_updated": datetime.now().strftime("%Y-%m-%d"),
            "total": len(deduped),
            "price_unit": "元/平方米",
            "coverage": {
                "with_avg_price": with_price,
                "with_build_year": with_year,
            }
        },
        "communities": deduped
    }

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log(f"=== 完成 → {OUT_FILE} ({len(deduped)} 个小区) ===")


if __name__ == "__main__":
    main()
