@echo off
REM Dashboard Frota 162 — Startup Script
REM This script ensures the server is always running on http://localhost:3002

title Frota 162 — RevOps Dashboard

echo.
echo ╔════════════════════════════════════════════════════════════════╗
echo ║                  FROTA 162 — REVOPS DASHBOARD                 ║
echo ║                                                                ║
echo ║  Dashboard oficial:  http://localhost:3002                     ║
echo ║  Abrindo navegador em 5 segundos...                            ║
echo ║                                                                ║
echo ║  Para parar: Feche esta janela ou pressione Ctrl+C             ║
echo ╚════════════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM Kill any existing node processes on port 3002
for /f "tokens=5" %%a in ('netstat -aon ^| find ":3002"') do taskkill /PID %%a /F 2>nul

REM Start the server
npm start

REM Keep window open if there's an error
if errorlevel 1 (
    echo.
    echo ERRO: Falha ao iniciar o servidor
    echo Verifique se Node.js está instalado e o arquivo .env está correto
    pause
)
