@echo off
chcp 65001 >nul
title 弹幕互动游戏中心
cd /d "%~dp0"

echo.
echo  ════════════════════════════════════════════
echo   弹幕互动游戏中心（danmu-games）
echo  ════════════════════════════════════════════
echo   启动后请：
echo     1. DanmuDesk 底部工具栏「转发」填写 ws://127.0.0.1:18080/danmu
echo        并勾选「启用转发」
echo     2. 浏览器打开主播台（各游戏控制台在左侧导航切换）：
echo        http://127.0.0.1:18080/control.html
echo     3. 投屏/OBS 浏览器源使用展示屏（按游戏）：
echo        猜数字：  http://127.0.0.1:18080/games/guess/public/stage.html
echo        成语接龙：http://127.0.0.1:18080/games/chengyu/public/stage.html
echo.
echo   关闭本窗口即停止游戏服务
echo  ════════════════════════════════════════════
echo.

node host/server.js

echo.
echo 游戏服务已退出
pause
