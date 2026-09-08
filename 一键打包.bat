@echo off
rem ASCII-only launcher (cmd parses batch files with the system codepage;
rem non-ASCII text here would garble - Chinese messages are printed by node instead)
cd /d "%~dp0"
node scripts\package.js
if errorlevel 1 (
  echo.
  echo Package FAILED - see errors above.
  pause
  exit /b 1
)
echo.
echo Output folder: %~dp0dist
start "" "%~dp0dist"
