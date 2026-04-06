# 技术架构

> 由 Claude 维护，所有人开工前必读。

## 项目目标

上海房源地图：抓取真实房源数据，在高德地图上可视化展示，辅助选房决策。

## 技术选型（草案，待确认）

| 层次 | 技术 |
|------|------|
| 地图 | 高德地图 JS API |
| 前端 | 原生 HTML/CSS/JS（轻量，无框架依赖） |
| 数据格式 | JSON |
| 数据来源 | OpenClaw 抓取（来源待定） |

## 数据 Schema

房源数据标准字段（OpenClaw 必须严格输出此格式）：

```json
{
  "id": "string",
  "title": "string",
  "price": number,          // 单位：元/月（租房）或万元（售房）
  "price_unit": "string",   // "元/月" | "万"
  "area": number,           // 平方米
  "district": "string",     // 行政区，如 "浦东新区"
  "address": "string",
  "lat": number | null,     // 纬度（抓取不到则 null，由高德补全）
  "lng": number | null,     // 经度
  "source": "string",       // 数据来源网站
  "url": "string",          // 原始链接
  "crawled_at": "string"    // ISO 8601 时间戳
}
```

> **注意**：lat/lng 为 null 时，由用户使用高德 skill 补全坐标，存入 `data/amap/`。

## 数据流

```
OpenClaw 抓取
    └→ data/raw/{来源}_{日期}.json
           ↓
    Claude 数据清洗脚本
           ↓
    data/processed/houses.json
           ↓ (lat/lng 缺失时)
    用户 高德 skill 补全坐标
           ↓
    data/amap/coords.json
           ↓
    前端地图展示 (src/)
```
