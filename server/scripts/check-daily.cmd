@echo off
REM Ежедневная проверка фейков (тег "Fakes | Sweeps"): whitelist + статусы
REM (живой/checkpoint/бан/разлогин/прокси/ошибка). Запускается Планировщиком в 4:00.
REM Требует запущенного Octo Browser (локальный API 127.0.0.1:58888).
setlocal
cd /d "%~dp0.."
if not exist "data\check-logs" mkdir "data\check-logs"
echo. >> "data\check-logs\daily-check.log"
echo ================ %DATE% %TIME% ================ >> "data\check-logs\daily-check.log"
node scripts\checkProfiles.js --tag="Fakes | Sweeps" --all --concurrency=15 >> "data\check-logs\daily-check.log" 2>&1
endlocal
