@echo off
title LinkedIn Scraper Server
cd /d "%~dp0"

echo ======================================================
echo    Iniciando Servidor do LinkedIn Scraper...
echo ======================================================
echo.
echo Acesse no seu navegador: http://localhost:3000
echo.
echo Para desligar o servidor, feche esta janela ou pressione Ctrl + C.
echo ======================================================
echo.

node server.js

pause
