#!/bin/bash
# 一键启动：自动处理数据 + 启动本地服务器
# 用法：bash scripts/start.sh

cd "$(dirname "$0")/.."
ROOT=$(pwd)
echo "========================================"
echo " 上海房源地图 - 启动脚本"
echo " 项目目录: $ROOT"
echo "========================================"

# 1. 检查 Python
if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
  echo "[错误] 未找到 Python，请先安装 Python 3.x"
  exit 1
fi
PYTHON=$(command -v python3 || command -v python)
echo "[1/3] Python: $($PYTHON --version)"

# 2. 如果 processed/communities.json 是 mock 数据（source=mock），尝试拉开源数据
PROCESSED="$ROOT/data/processed/communities.json"
if [ -f "$PROCESSED" ]; then
  SOURCE=$(python3 -c "import json;d=json.load(open('$PROCESSED'));print(d.get('_meta',{}).get('source','?'))" 2>/dev/null)
  if [ "$SOURCE" = "mock" ]; then
    echo "[2/3] 检测到 mock 数据，尝试拉取开源真实数据..."
    $PYTHON scripts/fetch_opensource.py
  else
    echo "[2/3] 已有处理后数据 (source=$SOURCE)，跳过下载"
  fi
else
  echo "[2/3] 未找到数据文件，尝试拉取开源数据..."
  $PYTHON scripts/fetch_opensource.py
fi

# 3. 启动 HTTP 服务器
PORT=8080
echo ""
echo "[3/3] 启动本地服务器 http://localhost:$PORT"
echo ""
echo "  ✓ 浏览器访问: http://localhost:$PORT/src/"
echo "  ✓ 粘贴高德 API Key → 点击「加载地图」"
echo "  ✓ 按 Ctrl+C 停止服务器"
echo ""

$PYTHON -m http.server $PORT
