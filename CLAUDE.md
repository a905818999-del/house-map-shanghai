# CLAUDE.md — 开发守则

> Claude 开工前必读。本文件优先级高于通用指令。

## 项目简介

上海小区房价地图，前端可视化 + 数据管道。核心文件：
- `src/` — 前端（原生 HTML/CSS/JS，无框架）
- `scripts/` — 数据清洗/抓取脚本（Python / Node.js）
- `data/processed/communities.json` — 前端直接读取的主数据

## 分支规范

| 类型 | 命名 |
|------|------|
| 功能 | `feat/xxx` |
| 修复 | `fix/xxx` |
| 重构 | `refactor/xxx` |
| 数据 | `data/xxx` |

- **不在 `main` 上直接提交代码**
- PR 合并前需通过本地验证（见下方）

## 提交规范

格式：`<type>: <中文描述>`

类型：`feat` / `fix` / `refactor` / `data` / `docs` / `chore`

示例：
```
feat: 通勤等时圈 Voronoi 渲染
fix: 公交色阶上限修正为 120min
data: 合并链家参考均价 20260416
```

## 验证流程

每次改动后必须验证，验证通过再提交：

```bash
# 启动本地服务器
npm start

# Python 脚本检查（有改动时）
python -m py_compile scripts/process.py
python -m py_compile scripts/merge_ref_price.py

# 数据完整性（改了数据后）
node -e "const d=require('./data/processed/communities.json'); console.log('communities:', d.communities.length)"
```

UI 改动必须在浏览器里实际点开确认，不能只靠静态检查。

## 数据约定

- 坐标系：**GCJ-02**（高德标准），原始 WGS-84 入库前必须转换
- 主数据文件 `data/processed/communities.json` schema 见 `ARCHITECTURE.md`
- 原始数据（`.csv` / `.xlsx` / 大型 `.json`）不入 git，存 `data/raw/`
- API Key 不入 git，存 `src/js/config.js`（已在 `.gitignore`）

## 目录结构

```
house-map-shanghai/
├── CLAUDE.md          # 本文件
├── README.md          # 项目概览 + 团队分工
├── ARCHITECTURE.md    # 技术架构 + Schema
├── DATA_SPEC.md       # 数据格式规范（WorkBuddy 执行文档）
├── TASKS.md           # 任务列表（Claude 维护）
├── data/
│   ├── raw/           # 原始数据（不入 git）
│   ├── processed/     # 清洗后数据（入 git）
│   └── external/      # 外部参考数据
├── scripts/           # 数据脚本
└── src/               # 前端源码
    ├── index.html     # 主应用
    ├── commute_iso.html  # 通勤等时圈
    ├── css/
    └── js/
```

## 常见命令

```bash
npm start              # 本地启动（http://localhost:8900/src/）
python scripts/process.py          # 重新生成 communities.json
python scripts/merge_ref_price.py  # 合并参考均价
```

## 注意事项

- 高德 API 有 QPS 限制，批量请求必须限速（已有 `rateLimiter` 实现）
- `data/processed/communities.json` 体积大（~3MB），不要做不必要的全量重写
- 通勤数据（`commute_targets.json`）按需更新，不随主数据自动覆盖
