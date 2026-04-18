# House Map Shanghai

上海房源地图 — 可视化展示上海各区房源数据，叠加地图信息辅助选房决策。

## 功能

| 模块 | 入口 | 状态 |
|------|------|------|
| 主地图（均价/楼龄热力图） | `src/index.html` | 上线 |
| 通勤等时圈（驾车/公交 Voronoi） | `src/commute_iso.html` | 上线 |

## 快速开始

```bash
# 安装依赖
npm install

# 启动主地图
npm start         # → http://localhost:8900/src/

# 启动通勤等时圈
npm run dev       # → http://localhost:8900/src/commute_iso.html

# 验证数据完整性
npm run verify:data

# 验证 Python 脚本语法
npm run verify:py
```

> 需要在 `src/js/config.js` 中配置高德地图 API Key（参考 `src/js/config.js.example`）。

## 团队分工

| 角色 | 负责内容 |
|------|----------|
| **Claude**（规划+开发） | 项目架构、开发任务拆解、前端/后端代码编写、代码审查、任务调度 |
| **OpenClaw**（数据抓取） | 按 Claude 下达的抓取任务执行，输出标准格式数据文件，不自行改变数据结构 |
| **用户**（高德地图） | 使用高德地图 skill 完成地图相关操作（POI 查询、路线规划、地图可视化等） |

## 工作规则

1. **以 GitHub 为唯一协作中心** — 代码、数据、文档全部提交到本仓库，不在聊天窗口里传文件
2. **先看文档再开工** — 每次开始工作前，先读 `TASKS.md` 确认当前任务，不重复劳动
3. **完成即更新状态** — 任务完成后，在 `TASKS.md` 里把对应任务标记为完成
4. **数据格式不得自行修改** — 数据 schema 由 Claude 定义，OpenClaw 严格按照 schema 输出
5. **不在 main 上直接提交** — 按分支规范建分支，PR 合并

### Claude 的职责

- 维护 `TASKS.md`（任务列表）和 `ARCHITECTURE.md`（技术架构）
- 向 OpenClaw 下达明确的抓取指令，包含：目标网站、字段、输出格式、存放路径
- 编写前端地图展示代码，集成高德地图 API

### OpenClaw 的职责

- 只执行 `TASKS.md` 中分配给自己的任务
- 抓取结果存放到 `data/raw/` 目录，文件名格式：`{来源}_{日期}.json`
- 遇到反爬/字段缺失等异常，在对应 task 下备注，等 Claude 决策，不自行处理

### 用户（高德地图 skill）的职责

- 执行高德相关任务（Claude 会在任务中标注 `[高德]`）
- 输出结果（POI 列表、坐标等）提交到 `data/amap/` 目录

## 目录结构

```
house-map-shanghai/
├── CLAUDE.md          # Claude 开发守则（AI 必读）
├── ARCHITECTURE.md    # 技术架构 + Schema
├── TASKS.md           # 当前任务列表（Claude 维护）
├── README.md          # 本文档
├── data/
│   ├── raw/           # 原始数据（不入 git）
│   ├── external/      # 外部参考数据
│   └── processed/     # 清洗后数据（入 git，boundaries.json 除外）
├── scripts/           # 数据脚本（Python + Node.js）
└── src/               # 前端源码
    ├── index.html
    ├── commute_iso.html
    ├── css/style.css
    └── js/app.js
```

## 文档索引

| 文档 | 内容 |
|------|------|
| `CLAUDE.md` | Claude 开发守则（分支/提交规范、验证流程） |
| `ARCHITECTURE.md` | 技术架构、数据 Schema、脚本清单 |
| `TASKS.md` | 当前任务列表 |
| `.github/pull_request_template.md` | PR checklist |
