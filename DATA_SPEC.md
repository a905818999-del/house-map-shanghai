# 数据采集规范（WorkBuddy 执行文档）

> **执行者：WorkBuddy（OpenClaw）**
> **监督：Claude**
> **目标：提供符合下述 schema 的上海小区数据，供前端地图直接读取**

---

## 任务目标

抓取上海各小区的以下核心字段，输出标准 JSON 文件：

| 字段 | 说明 | 优先级 |
|------|------|--------|
| 小区名 | 完整小区名称 | ★★★ 必须 |
| 经纬度 | GCJ-02 坐标（高德标准） | ★★★ 必须 |
| 均价 | 元/平方米 | ★★★ 必须 |
| 建成年份 | 四位年份，如 2003 | ★★★ 必须 |
| 行政区 | 如 "浦东新区" | ★★★ 必须 |
| 街道/镇 | 如 "金桥镇" | ★★ 尽量有 |
| 楼栋数 | 整数 | ★ 有更好 |
| 总套数 | 整数 | ★ 有更好 |
| 来源 URL | 原始链接 | ★ 有更好 |

---

## 推荐数据源

### 优先：链家小区列表页（sh.lianjia.com/xiaoqu/）

每个小区的详情页包含全部所需字段。

**第一批目标入口（长宁 + 闵行）：**

```
https://sh.lianjia.com/xiaoqu/changning/    # 长宁区 ← 第一批
https://sh.lianjia.com/xiaoqu/minhang/      # 闵行区 ← 第一批
```

**后续批次备用入口（第二批再处理）：**

```
https://sh.lianjia.com/xiaoqu/pudong/       # 浦东新区
https://sh.lianjia.com/xiaoqu/jing_an/      # 静安区
https://sh.lianjia.com/xiaoqu/xuhui/        # 徐汇区
https://sh.lianjia.com/xiaoqu/huangpu/      # 黄浦区
https://sh.lianjia.com/xiaoqu/putuo/        # 普陀区
https://sh.lianjia.com/xiaoqu/hongkou/      # 虹口区
https://sh.lianjia.com/xiaoqu/yangpu/       # 杨浦区
https://sh.lianjia.com/xiaoqu/baoshan/      # 宝山区
https://sh.lianjia.com/xiaoqu/jiading/      # 嘉定区
https://sh.lianjia.com/xiaoqu/songjiang/    # 松江区
https://sh.lianjia.com/xiaoqu/qingpu/       # 青浦区
https://sh.lianjia.com/xiaoqu/fengxian/     # 奉贤区
https://sh.lianjia.com/xiaoqu/jinshan/      # 金山区
```

**字段抓取位置**（小区列表卡片/详情页）：

| 目标字段 | 链家页面位置 |
|----------|------------|
| 小区名 | `.xiaoquListItem .title` 或小区详情页 `<h1>` |
| 均价 | `.xiaoquListItem .totalPrice` 或 `.unitPrice` |
| 建成年份 | 小区详情页「楼盘信息」→「建成年代」 |
| 行政区 | URL 路径 或页面面包屑 |
| 街道 | 小区详情页地址字段 |
| 经纬度 | **方案A**：页面 JS 变量 `resblockPosition`（JSON内嵌）；**方案B**：调用高德地图 API 用地址反查 |
| 楼栋数 | 小区详情页「楼栋总数」 |
| 总套数 | 小区详情页「房屋总数」 |

### 备选：GitHub 现成数据集（可免抓）

如果链家反爬太强，可直接用这两个已有数据集处理后导入：

```
# 2023年，42,982条挂牌数据，MIT协议，含经纬度+建造年份
https://github.com/WxxW2002/Spider
文件：data_with_coordinates.csv
字段：Community, Latitude, Longitude, Average(元/m²), Build Time(年), District

# 2016年，14,363个小区已聚合，含经纬度+均价+房龄
https://github.com/likkhello/shanghai_lianjia_house_price
文件：data/lianjia_shanghai_communities.json
字段：lat, lng, avr_price, age（相对2016年的年龄，需转换为年份）
```

---

## 输出格式（严格遵守）

**文件路径**：`data/raw/lianjia_{YYYYMMDD}.json`

**格式**：

```json
{
  "_meta": {
    "source": "lianjia",
    "crawled_at": "2024-04-07T10:00:00Z",
    "total": 500,
    "crawler": "WorkBuddy"
  },
  "communities": [
    {
      "id": "lianjia_1234567",
      "name": "碧云社区",
      "district": "浦东新区",
      "subdistrict": "金桥镇",
      "lat": 31.2218,
      "lng": 121.5689,
      "avg_price": 98000,
      "build_year": 2003,
      "total_buildings": 14,
      "total_units": 1280,
      "source": "lianjia",
      "source_url": "https://sh.lianjia.com/xiaoqu/1234567.html"
    }
  ]
}
```

---

## 字段规范

| 字段 | 类型 | 规范 |
|------|------|------|
| `id` | string | `{来源}_{原始ID}`，如 `lianjia_123456` |
| `name` | string | 完整小区名，去掉「上海」前缀 |
| `district` | string | 标准行政区名，含「区」字，如 `"浦东新区"` |
| `subdistrict` | string \| null | 街道或镇名，含「街道」/「镇」字；无则填 `null` |
| `lat` | number | GCJ-02 纬度，保留 4 位小数 |
| `lng` | number | GCJ-02 经度，保留 4 位小数 |
| `avg_price` | number \| null | 元/平方米，整数；无数据填 `null` |
| `build_year` | number \| null | 四位年份，如 `2003`；无数据填 `null` |
| `total_buildings` | number \| null | 正整数；无数据填 `null` |
| `total_units` | number \| null | 正整数；无数据填 `null` |
| `source` | string | 固定值 `"lianjia"` 或 `"beike"` |
| `source_url` | string | 完整 URL；无则填 `""` |

### 坐标系说明（重要）

- 高德地图使用 **GCJ-02** 坐标系（火星坐标系）
- 链家/贝壳页面内嵌坐标**已经是 GCJ-02**，直接用
- 如果从百度地图或 WGS-84（GPS）换算，需要做坐标转换
- **不要使用 BD-09（百度坐标）**，会有偏移

---

## 交付检查清单

WorkBuddy 提交前请自查：

- [ ] 文件放在 `data/raw/` 目录下
- [ ] 文件名包含日期，如 `lianjia_20240407.json`
- [ ] JSON 格式合法（可用 `python -m json.tool` 验证）
- [ ] `_meta.total` 与实际 `communities` 数组长度一致
- [ ] 所有必填字段（name/district/lat/lng）都不为 null
- [ ] lat 范围在 30.7–31.9，lng 范围在 120.8–122.2（上海范围）
- [ ] avg_price 单位是**元/平方米**（不是万元）
- [ ] build_year 是四位年份（不是「5年」这种相对值）

---

## Claude 收到数据后做什么

WorkBuddy 提交 raw 数据后，Claude 会运行清洗脚本：

```
data/raw/lianjia_{date}.json
        ↓ scripts/process.py（Claude 写）
data/processed/communities.json  ← 前端直接读取
```

清洗脚本会：去重、坐标校验、价格单位统一、合并多个 raw 文件。

---

## 数量目标

| 阶段 | 目标 | 说明 |
|------|------|------|
| ~~第一批~~ | ~~≥ 200 个小区~~ | ✅ Claude 已用开源数据完成（10,305 个小区） |
| **第二阶段** | 长宁+闵行参考均价 | 链家小区详情页「参考均价」字段（约 1755 个） |
| 第三阶段 | 全上海参考均价 | 同上，扩展到全部 10,305 个小区 |

---

## 第二阶段任务：补充链家「参考均价」

### 背景

现有 `avg_price` 字段来自链家挂牌房源均价（报价），精度一般。
链家小区详情页有「**参考均价**」字段，基于近期真实成交均价，更准。

目标：用参考均价**替换**现有挂牌均价。

### 输入（已提供）

项目 `data/processed/communities.json` 中每个小区有 `source_url` 字段：

```
"source_url": "https://sh.lianjia.com/xiaoqu/310112077000001.html"
```

WorkBuddy 直接用这批 URL 访问对应小区详情页，抓「参考均价」。

**优先处理长宁区+闵行区**（按 district 字段筛选）

### 抓取目标

链家小区详情页：`https://sh.lianjia.com/xiaoqu/{id}.html`

| 目标字段 | 页面位置 |
|----------|---------|
| 参考均价 | 页面右上方「参考均价 XX,XXX元/㎡」 |
| 最近成交 | 「最近成交 YYYY.MM」（可选） |

### 输出格式

**文件路径**：`data/raw/lianjia_ref_price_{YYYYMMDD}.json`

```json
{
  "_meta": {
    "source": "lianjia_ref_price",
    "crawled_at": "2024-04-07T10:00:00Z",
    "total": 500,
    "crawler": "WorkBuddy",
    "note": "参考均价，基于近期成交，单位元/平方米"
  },
  "ref_prices": [
    {
      "source_url": "https://sh.lianjia.com/xiaoqu/310112077000001.html",
      "ref_price": 95000,
      "last_deal": "2024.03"
    }
  ]
}
```

### 字段规范

| 字段 | 类型 | 规范 |
|------|------|------|
| `source_url` | string | 与 communities.json 中完全一致，作为关联 key |
| `ref_price` | number | 元/平方米，整数；页面无数据填 `null` |
| `last_deal` | string \| null | 格式 `"YYYY.MM"`；无则填 `null` |

### 交付检查清单

- [ ] 文件放在 `data/raw/` 目录下
- [ ] JSON 格式合法
- [ ] `ref_price` 单位是元/平方米（不是万元）
- [ ] `source_url` 与 communities.json 中的 URL 完全一致（作为合并 key）
- [ ] `_meta.total` 与 `ref_prices` 数组长度一致
| 理想状态 | 5000+ 个小区 | 参考链家约有 14,000+ 上海小区 |
