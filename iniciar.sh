#!/usr/bin/env bash
# ==============================================================================
# Launcher para Linux: LinkedIn Scraper & Model Explorer
# ==============================================================================
cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
    echo "[INFO] Instalando dependências pela primeira vez..."
    npm install
fi

# Executa o Electron nativamente
npx electron .

