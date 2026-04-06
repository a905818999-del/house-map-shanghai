# 上海房龄+房价可视化地图

基于Leaflet的上海小区房价和楼龄可视化系统。

## 功能特点

- 🗺️ **交互式地图**：Leaflet + OpenStreetMap
- 📊 **双维度可视化**：楼龄颜色 + 房价颜色
- 🔍 **多条件筛选**：行政区、价格区间、楼龄范围
- 📋 **小区详情**：点击查看完整信息

## 快速开始

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 初始化数据库
python init_db.py

# 3. 运行爬虫（获取数据）
python run_scraper.py

# 4. 启动服务
python app.py

# 5. 打开浏览器
# http://localhost:5000
```

## 数据说明

楼龄颜色映射：
- 🟢 绿色：0-5年新房
- 🟡 黄绿：5-10年次新房
- 🟡 黄色：10-15年中房
- 🟠 橙色：15-20年老房
- 🔴 红色：20年以上老旧房

房价颜色映射（按单价）：
- 🟢 <4万：低价
- 🟡 4-6万：较低价
- 🟡 6-8万：中价
- 🟠 8-10万：较高价
- 🔴 >10万：高价

## 项目结构

```
house-price-map/
├── app.py              # Flask主应用
├── database.py         # 数据库模块
├── scraper.py          # 数据爬虫
├── init_db.py          # 初始化脚本
├── requirements.txt    # 依赖
├── templates/
│   └── index.html      # 主页面
└── static/
    ├── css/style.css   # 样式
    └── js/
        ├── map.js      # 地图模块
        ├── filters.js # 筛选模块
        └── utils.js    # 工具函数
```

## API接口

- `GET /api/communities` - 获取小区列表（支持筛选）
- `GET /api/communities/<id>` - 获取小区详情
- `GET /api/districts` - 获取行政区列表
- `GET /api/stats` - 获取统计信息
