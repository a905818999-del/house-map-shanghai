# 任务列表

> 最后更新: 2026-04-15

## 团队分工

| 角色 | 职责 |
|------|------|
| **Claude** | 整体规划、前端地图、数据清洗脚本 |
| **WorkBuddy** | 数据抓取，输出 `data/raw/` 下的标准 JSON |
| **她** | 高德地图 skill 支持 |

> 详细数据格式和字段规范见 [`DATA_SPEC.md`](DATA_SPEC.md)

---

## 阶段 0：项目初始化 ✅

- [x] 创建仓库结构和协作文档
- [x] 确定技术方案：高德地图 JS API v2 + 原生 HTML/CSS/JS
- [x] 调研 GitHub 现有项目和数据集
- [x] 更新 ARCHITECTURE.md，确定小区级 schema 和数据流
- [x] 撰写 DATA_SPEC.md（WorkBuddy 执行文档）

---

## 阶段 1：基础框架 ✅

- [x] `src/index.html` — 布局、侧边栏、筛选面板、文件上传
- [x] `src/css/style.css` — 完整样式
- [x] `src/js/app.js` — 基础逻辑
- [x] 高德地图 JS API v2 集成 + API Key 自动加载
- [x] 基础筛选（区、价格、楼龄）
- [x] 热力图模式
- [x] 侧边栏列表 + 排序 + 飞跳
- [x] CSV 导出
- [x] `scripts/start.bat` / `start.sh` 一键启动

---

## 阶段 2a：数据管道 ✅

- [x] `scripts/process.py` — 清洗管道（自动识别三种格式）
- [x] `scripts/fetch_opensource.py` — 一键拉取开源数据集
- [x] 已获取真实数据：`data/processed/communities.json`
  - 来源：WxxW2002/Spider（2023年，MIT协议）
  - 42,983 条挂牌 → 聚合出 **10,305 个上海小区**
  - 均价覆盖 100%，建成年份覆盖 96%
  - 覆盖全上海 16 个区

---

## 阶段 2b：v2 重构 ✅

### Step 1: 坐标修复 ✅
- [x] process.py 加入 WGS-84 → GCJ-02 坐标转换
- [x] 重新生成 communities.json（10,305 个小区全部转换）

### Step 2: 四象限分层渲染 ✅
- [x] 删除 zoom ≤ 11 行政区色块
- [x] 四象限逻辑（洼地🟢 / 警告🔴 / 新贵🟣 / 正常🟡）
- [x] LOD 分层：zoom < 10 热力图 → 10-12 价格胶囊 → 12-14 四象限圆点 → ≥14 详细卡片
- [x] 板块偏差%计算（按行政区均价）

### Step 3: 环线 + CAZ 图层 ✅
- [x] 内环（红色虚线）/ 中环（橙色虚线）/ 外环（灰色虚线）
- [x] CAZ 核心活动区（蓝色半透明多边形）
- [x] `data/rings.json` 坐标数据（OSM 导出 + GCJ-02 转换）

### Step 4: 洼地模式 + 榜单 ✅
- [x] 「洼地模式」开关（只显示绿色小区）
- [x] 侧边栏「洼地榜」Tab，按偏差%排序

### Step 5: 通勤计算 ✅
- [x] 支持 2 个目的地（AMap.PlaceSearch 地址搜索）
- [x] 驾车 / 公交 模式切换
- [x] 分批请求 + QPS 限流 + 结果缓存
- [x] Marker 叠加通勤时间标注
- [x] 侧边栏「通勤」Tab

---

## 阶段 3：增强功能 ✅

- [x] 收藏功能（localStorage 持久化）
- [x] InfoWindow 收藏按钮
- [x] 侧边栏「⭐ 收藏」Tab + 角标
- [x] `scripts/merge_ref_price.py` 参考均价合并脚本

---

## 阶段 4：待验证/优化 🔄

### 待验证（功能已写但未在真实浏览器充分测试）
- [ ] 四象限圆点显示是否正确
- [ ] 环线/CAZ 位置是否准确
- [ ] 洼地模式筛选是否正常
- [ ] 通勤计算是否能正常请求高德 API
- [ ] 收藏功能是否正常工作
- [ ] 坐标偏移是否已修复（小区标签对准真实位置）
- [ ] Marker 卡顿问题是否解决

### 已知问题
- [ ] Marker 样式需进一步优化（之前多次改动，最终效果待确认）
- [ ] 数据是 2023 年挂牌价，非成交价，待 WorkBuddy 补充

---

## 阶段 5：数据迭代 ⬚

### WorkBuddy 任务
- [ ] 抓取链家小区详情页「参考均价」（基于近期成交）
- [ ] 输出 `data/raw/lianjia_ref_price_YYYYMMDD.json`
- [ ] 格式见 DATA_SPEC.md 第二阶段

### 数据合并
- [ ] 收到后运行 `scripts/merge_ref_price.py` 合并进 communities.json

---

## 配置信息

- 高德 JS API Key: `1cf0650cf8cc24f862e1d3a1d023b93c`（Web端JS类型）
- 安全密钥: `e808269f0141b67e76ee446b1542b3c0`
- GeoHub 样式 ID: `2bb510e892ed63c94e9128832a156164`
- 本地启动: 双击 `scripts\start.bat` → `http://localhost:8080/src/index.html`
