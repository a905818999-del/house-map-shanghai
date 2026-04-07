# 任务列表

> 由 Claude 维护。完成任务后请更新状态。

## 状态说明

- `[ ]` 待开始
- `[→]` 进行中
- `[x]` 已完成
- `[!]` 有问题，等决策

---

## 分工一览

| 角色 | 职责 |
|------|------|
| **Claude** | 整体规划、前端地图、数据清洗脚本 |
| **WorkBuddy** | 数据抓取，输出 `data/raw/` 下的标准 JSON |

> 详细数据格式和字段规范见 [`DATA_SPEC.md`](DATA_SPEC.md)

---

## 阶段 0：项目初始化 ✅

- [x] **[Claude]** 创建仓库结构和协作文档
- [x] **[Claude]** 确定技术方案：高德地图 JS API v2 + 原生 HTML/CSS/JS
- [x] **[Claude]** 调研 GitHub 现有项目和数据集
- [x] **[Claude]** 更新 ARCHITECTURE.md，确定小区级 schema 和数据流
- [x] **[Claude]** 撰写 DATA_SPEC.md（WorkBuddy 执行文档）

---

## 阶段 1：地图前端（Claude 负责）✅

- [x] `src/index.html` — 布局、侧边栏、筛选面板、文件上传、热力图按钮
- [x] `src/css/style.css` — 完整样式
- [x] `src/js/app.js` — 全部逻辑：
  - 高德地图动态加载、多路径数据加载、文件拖拽上传
  - 颜色模式切换（按均价 / 按楼龄）
  - **热力图叠加层**（AMap.HeatMap，随模式切换渐变方向）
  - 小区 Marker、点击弹出 InfoWindow（均价/楼龄/双色条）
  - 行政区 chip 筛选、价格/年份滑块、名称搜索
  - 结果列表（可点击飞跳定位）、导出 CSV、Esc 关闭窗口
  - 数据概览统计、色阶图例

## 阶段 2b：数据管道（Claude 负责）✅

- [x] `scripts/process.py` — 清洗管道（自动识别三种格式）
- [x] `scripts/fetch_opensource.py` — 一键拉取开源数据集
- [x] `scripts/start.bat` / `start.sh` — 一键启动
- [x] **已获取真实数据**：`data/processed/communities.json`
  - 来源：WxxW2002/Spider（2023年，MIT协议）
  - 42,983条挂牌 → 聚合出 **10,305 个上海小区**
  - 均价覆盖 100%，建成年份覆盖 96%
  - 覆盖全上海 16 个区，浦东最多（2303），长宁（710），闵行（1045）

**一键启动（Windows）：**
```
双击 scripts\start.bat
```

**手动启动：**
```bash
cd "house map"
python -m http.server 8080
# 访问 http://localhost:8080/src/
# 粘贴高德 API Key → 加载地图
```

**立即获取真实数据（无需等 WorkBuddy）：**
```bash
python scripts/fetch_opensource.py
# 自动下载 WxxW2002/Spider 2023年数据 + likkhello 2016年数据，合并处理
```

---

## 阶段 2：数据采集（WorkBuddy 负责）

> **详见 [`DATA_SPEC.md`](DATA_SPEC.md)**，里面有完整的字段规范、抓取目标和交付检查清单。

### 第一批（目标 ≥200 个小区）

- [ ] **[WorkBuddy]** 抓取链家上海小区数据
  - 覆盖区：**长宁区、闵行区**
  - 必须字段：`name / district / lat / lng / avg_price / build_year`
  - 输出：`data/raw/lianjia_{YYYYMMDD}.json`
  - 格式参考：`DATA_SPEC.md` → 「输出格式」一节

- [ ] **[WorkBuddy]** 自查交付（DATA_SPEC.md 检查清单）

- [ ] **[Claude]** 收到后运行清洗脚本 → 更新 `data/processed/communities.json`

### 第二批（目标 ≥2000 个小区，全上海）

- [ ] **[WorkBuddy]** 覆盖剩余 10 个区：宝山、嘉定、松江、青浦、奉贤、金山、虹口、杨浦、黄浦、普陀

---

## 阶段 3：数据清洗（Claude 负责）✅

- [x] **[Claude]** 写 `scripts/process.py`：
  - 读取 `data/raw/*.json`
  - 去重（按 source_url 或 name+district）
  - 坐标范围校验（上海范围）
  - avg_price 单位校验（元/m²，不是万）
  - build_year 格式校验（1950–2025 范围）
  - 输出 `data/processed/communities.json`

---

## 阶段 4：增强功能（待排期）

- [ ] 热力图覆盖模式
- [ ] 小区列表面板（按筛选结果排序）
- [ ] 导出筛选结果为 CSV
- [ ] 支持收藏/标注关注小区

---

## 备注区

**坐标系**：高德地图用 GCJ-02，链家/贝壳页面内嵌坐标已是 GCJ-02，直接用。

**已知可用数据集（备选，免抓）**：
- `github.com/WxxW2002/Spider` — MIT，2023，42,982条挂牌，含坐标+建造年份（需按小区聚合）
- `github.com/likkhello/shanghai_lianjia_house_price` — 无协议，2016，14,363小区聚合，含坐标

_有阻塞问题请在此记录_
