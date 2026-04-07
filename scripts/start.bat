@echo off
chcp 65001 >nul
REM 一键启动：自动处理数据 + 启动本地服务器
REM 用法：双击此文件 或 cmd 运行 scripts\start.bat

cd /d "%~dp0.."
echo ========================================
echo  上海房源地图 - 启动脚本
echo  项目目录: %CD%
echo ========================================

REM 1. 检查 Python
where python >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Python，请先安装 Python 3.x
  pause
  exit /b 1
)
echo [1/3] Python: 已找到

REM 2. 检查是否需要拉取数据
set PROCESSED=data\processed\communities.json
python -c "import json,sys; d=json.load(open('%PROCESSED%',encoding='utf-8')); sys.exit(0 if d.get('_meta',{}).get('source')!='mock' else 1)" 2>nul
if errorlevel 1 (
  echo [2/3] 检测到 mock 数据，尝试拉取开源真实数据...
  python scripts\fetch_opensource.py
) else (
  echo [2/3] 已有真实数据，跳过下载
)

REM 3. 启动服务器
echo.
echo [3/3] 启动本地服务器...
echo.
echo   * 浏览器访问: http://localhost:8080/src/
echo   * 粘贴高德 API Key 点击「加载地图」
echo   * 按 Ctrl+C 停止
echo.

python -m http.server 8080
pause
