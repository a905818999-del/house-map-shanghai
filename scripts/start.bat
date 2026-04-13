@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."

echo ========================================
echo   上海房价楼龄地图 - 启动中
echo   项目目录: %CD%
echo ========================================

REM 先杀掉已有的 8080 进程，避免端口冲突
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1
)

echo.
echo 浏览器访问: http://localhost:8080/src/index.html
echo 按 Ctrl+C 停止
echo.
start "" "http://localhost:8080/src/index.html"
python -m http.server 8080
pause
