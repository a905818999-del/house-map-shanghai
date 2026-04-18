# 技术架构

> 由 Claude 维护，所有人开工前必读。最后更新：2026-04-19

## 项目目标

上海小区房龄+房价可视化地图：以小区为单位，在高德地图上用颜色标识均价和楼龄，辅助选房决策。
同时提供通勤等时圈功能：以目标地点为中心，渲染驾车/公交通勤时间的 Voronoi 热力图。

## 技术选型

| 层次 | 技术 |
|------|------|
| 地图 | 高德地图 JS API v2 |
| 前端 | 原生 HTML/CSS/JS（无框架依赖） |
| 通勤渲染 | D3 Voronoi + Canvas 叠层 |
| 数据格式 | JSON |
| 数据来源 | 链家/贝壳爬取 + OSM 边界 |

## 应用模块

### 1. 主地图（`src/index.html`）

- 颜色模式：按均价着色 / 按楼龄着色
- 小区圆形气泡 Marker，颜色表示价格/年龄分档
- 聚合（缩放时自动合并密集点）
- 点击气泡弹出详情
- 左侧筛选面板：行政区多选、价格区间、楼龄区间
- 实时搜索小区名

### 2. 通勤等时圈（`src/commute_iso.html`）

- 选择目标通勤地点（预设 + 自定义）
- 驾车 / 公交 两种模式独立色阶
- 驾车色阶：0–60 min（0–15–20–25–30–35–40–45–50–55–60–60+）
- 公交色阶：0–120 min（同颗粒度）
- zoom < 13：D3 Voronoi 等高图（面渲染）
- zoom ≥ 13：小区名标签（点渲染）
- 邻居差值边缘渐变

## 数据 Schema

### communities.json（主数据）

**路径**：`data/processed/communities.json`  
**大小**：约 3MB，不做不必要的全量重写

```json
{
  "_meta": {
    "description": "上海小区房价+楼龄数据",
    "schema_version": "1.0",
    "source": "lianjia",
    "last_updated": "YYYY-MM-DD",
    "price_unit": "元/平方米",
    "total": 0
  },
  "communities": [
    {
      "id": "string",
      "name": "string",
      "district": "string",
      "subdistrict": "string",
      "lat": number,
      "lng": number,
      "avg_price": number,
      "build_year": number,
      "total_buildings": number,
      "total_units": number,
      "source": "string",
      "source_url": "string"
    }
  ]
}
```

### commute_iso_driving.json / commute_iso_transit.json

**路径**：`data/processed/`  
通勤时间预计算结果，按目标地点分组：

```json
{
  "target_id": "string",
  "mode": "driving | transit",
  "data": [
    { "community_id": "string", "minutes": number }
  ]
}
```

### commute_targets.json

**路径**：`data/processed/commute_targets.json`  
目标地点列表（940KB），含名称、坐标、类别。

### boundaries.json

**路径**：`data/processed/boundaries.json`（**不入 git**，约 20MB）  
OSM 行政区划边界，本地从 `scripts/fetch_osm_boundaries.mjs` 生成。

## 数据流

```
链家网站
  └→ scripts/fetch_lianjia_listings.mjs   爬取挂牌数据
  └→ scripts/fetch_lianjia_ref_price.mjs  爬取参考均价
        ↓
  data/raw/{来源}_{日期}.json
        ↓
  scripts/process.py          清洗 → communities.json
  scripts/merge_ref_price.py  合并参考均价

高德地图 API
  └→ scripts/precompute_commute_iso.mjs   预计算通勤时间
        ↓
  data/processed/commute_iso_driving.json
  data/processed/commute_iso_transit.json

OSM
  └→ scripts/fetch_osm_boundaries.mjs    下载行政区边界
  └→ scripts/fetch_ring_roads.mjs        下载环线道路
        ↓
  data/processed/boundaries.json（本地用，不入库）
  data/rings.json
```

## 脚本清单

| 脚本 | 语言 | 用途 |
|------|------|------|
| `fetch_lianjia_listings.mjs` | Node.js | 爬取链家挂牌数据 |
| `fetch_lianjia_ref_price.mjs` | Node.js | 爬取链家参考均价 |
| `fetch_osm_boundaries.mjs` | Node.js | 下载 OSM 行政区边界 |
| `fetch_ring_roads.mjs` | Node.js | 下载上海环线道路 |
| `fetch_opensource.py` | Python | 下载开源数据集 |
| `process.py` | Python | 清洗原始数据 → communities.json |
| `merge_ref_price.py` | Python | 合并链家参考均价 |
| `filter_commute_targets.py` | Python | 过滤通勤目标地点 |
| `generate_voronoi.mjs` | Node.js | 生成 Voronoi 分区（离线预计算） |
| `precompute_commute_iso.mjs` | Node.js | 调高德 API 预计算通勤时间 |
| `watchdog_crawl.sh` | Bash | 爬取守护进程 |
| `start.sh` / `start.bat` | Shell | 启动本地服务器 |

## 注意事项

- 高德 API 有 QPS 限制，批量请求通过 `rateLimiter` 限速（已实现）
- `data/processed/communities.json` 约 3MB，不要做不必要的全量重写
- `data/processed/boundaries.json` 约 20MB，已加入 `.gitignore`，本地生成
- 通勤数据（`commute_iso_*.json`）按需更新，不随主数据自动覆盖
- 坐标系：**GCJ-02**（高德标准），原始 WGS-84 入库前必须转换
