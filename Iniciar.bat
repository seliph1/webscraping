@echo off
title LinkedIn Scraper - CEFET-RJ
cd /d "%~dp0"

echo ========================================================
echo   Iniciando LinkedIn Scraper & Model Explorer (Electron)
echo ========================================================

REM Verifica se os modulos estao instalados
if not exist "node_modules\" (
    echo [INFO] Instalando dependencias necessarias pela primeira vez...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERRO] Falha ao instalar dependencias do Node.js.
        pause
        exit /b 1
    )
)

REM Inicia a aplicacao Desktop via Electron
call npx electron .
if %errorlevel% neq 0 (
    echo.
    echo [ERRO] Falha ao executar o aplicativo Electron.
    echo Tentando iniciar via servidor web padrao...
    call npm run web
    pause
)

