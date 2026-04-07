# 技术架构

> 由 Claude 维护，所有人开工前必读。

## 项目目标

上海小区房龄+房价可视化地图：以小区为单位，在高德地图上用颜色标识均价和楼龄，辅助选房决策。

## 技术选型

| 层次 | 技术 |
|------|------|
| 地图 | 高德地图 JS API v2 |
| 前端 | 原生 HTML/CSS/JS（无框架依赖） |
| 数据格式 | JSON |
| 数据来源（规划） | 链家/贝壳小区数据（爬取或手动整理） |

## 小区数据 Schema

**文件路径**：`data/processed/communities.json`

```json
{
  "_meta": {
    "description": "上海小区房价+楼龄数据",
    "schema_version": "1.0",
    "source": "mock | lianjia | beike",
    "last_updated": "YYYY-MM-DD",
    "price_unit": "元/平方米",
    "total": 0
  },
  "communities": [
    {
      "id": "string",              // 唯一ID
      "name": "string",           // 小区名称
      "district": "string",       // 行政区，如 "浦东新区"
      "subdistrict": "string",    // 街道/镇，如 "金桥镇"（可为空）
      "lat": number,              // 纬度（GCJ-02坐标，高德标准）
      "lng": number,              // 经度
      "avg_price": number,        // 均价，元/平方米（null=无数据）
      "build_year": number,       // 建成年份，如 2003（null=无数据）
      "total_buildings": number,  // 总楼栋数（可为null）
      "total_units": number,      // 总套数（可为null）
      "source": "string",         // 数据来源，如 "lianjia"
      "source_url": "string"      // 原始链接（可为空）
    }
  ]
}
```

## 数据流

```
现有开源数据集（见下）
    └→ data/raw/{来源}_{日期}.json / .csv
           ↓
    数据清洗脚本 scripts/process.py（待写）
           ↓
    data/processed/communities.json  ← 前端直接读取
           ↓
    src/index.html 高德地图展示
```

## 已知可用数据源

| 来源 | 数据 | 年份 | 字段 |
|------|------|------|------|
| `likkhello/shanghai_lianjia_house_price` | 14,363个小区，含lat/lng/均价/楼龄 | 2016 | id, lat, lng, avr_price, age |
| `WxxW2002/Spider` (data_with_coordinates.csv) | 42,982条挂牌，含建造年份 | 2023 | Community, Latitude, Longitude, Average, Build Time, District |

> 说明：WxxW2002数据是挂牌级，需按小区聚合取均价。

## 前端功能

- 颜色模式切换：按均价着色 / 按楼龄着色
- 小区圆形气泡 Marker，颜色表示价格/年龄分档
- 聚合（缩放时自动合并密集点）
- 点击气泡弹出详情：小区名、均价、建成年份、楼栋/套数、所属区
- 左侧筛选面板：行政区多选、价格区间、楼龄区间
- 实时搜索小区名
- 色阶图例
