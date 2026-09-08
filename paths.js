/**
 * ============================================================================
 * UTILITÁRIO DE CAMINHOS DINÂMICOS & DIRETÓRIOS EXTERNOS
 * ============================================================================
 * Centraliza a resolução de diretórios de armazenamento e recursos.
 * Garante que:
 *  1. Quando empacotado no Electron (.exe ou unpacked), as pastas 'dados_json',
 *     'pdfs' e os arquivos 'auth.json' e 'egressos.pbix' fiquem no diretório EXTERNO
 *     onde o .exe está instalado ou executando, fora do app.asar.
 *  2. Caso 'egressos.pbix' não exista ainda no diretório externo, uma cópia
 *     do modelo padrão integrado é copiada automaticamente para lá.
 *  3. Os navegadores embutidos (browsers/) sejam localizados dentro de process.resourcesPath.
 *  4. Em modo desenvolvimento (npm start / npm run web), utilize a raiz do projeto.
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');

/**
 * Diretório base externo para dados manipuláveis pelo usuário:
 * No Electron empacotado: pasta onde reside o executável (path.dirname(process.execPath))
 * Em desenvolvimento: __dirname do projeto
 */
function getExternalBaseDir() {
    if (process.env.APP_DATA_DIR) {
        return process.env.APP_DATA_DIR;
    }
    if (process.resourcesPath && process.execPath && !process.execPath.toLowerCase().endsWith('electron.exe')) {
        return path.dirname(process.execPath);
    }
    return path.resolve(__dirname);
}

const EXTERNAL_BASE_DIR = getExternalBaseDir();

// Pastas de dados externas garantidas fora do .asar
const PDFS_DIR = path.join(EXTERNAL_BASE_DIR, 'pdfs');
const JSON_DIR = path.join(EXTERNAL_BASE_DIR, 'dados_json');
const AUTH_PATH = path.join(EXTERNAL_BASE_DIR, 'auth.json');
const PBIX_PATH = path.join(EXTERNAL_BASE_DIR, 'egressos.pbix');

// Garante a existência das pastas externas
if (!fs.existsSync(PDFS_DIR)) {
    try {
        fs.mkdirSync(PDFS_DIR, { recursive: true });
    } catch (e) {
        console.error('Aviso: Não foi possível criar a pasta pdfs:', e.message);
    }
}

if (!fs.existsSync(JSON_DIR)) {
    try {
        fs.mkdirSync(JSON_DIR, { recursive: true });
    } catch (e) {
        console.error('Aviso: Não foi possível criar a pasta dados_json:', e.message);
    }
}

// Se o egressos.pbix externo ainda não existir na pasta do .exe, copia o padrão inicial
const defaultInternalPbix = path.join(__dirname, 'egressos.pbix');
if (!fs.existsSync(PBIX_PATH) && fs.existsSync(defaultInternalPbix)) {
    try {
        fs.copyFileSync(defaultInternalPbix, PBIX_PATH);
        console.log('Arquivo egressos.pbix inicial provisionado em:', PBIX_PATH);
    } catch (e) {
        console.warn('Aviso ao provisionar egressos.pbix externo:', e.message);
    }
}

/**
 * Retorna o caminho dos navegadores embutidos do Playwright
 */
function getBrowsersPath() {
    // 1. Variável de ambiente explícita
    if (process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) {
        return process.env.PLAYWRIGHT_BROWSERS_PATH;
    }

    // 2. Se empacotado no Electron, procurar em process.resourcesPath/browsers
    if (process.resourcesPath) {
        const bundledInResources = path.join(process.resourcesPath, 'browsers');
        if (fs.existsSync(bundledInResources)) {
            return bundledInResources;
        }
    }

    // 3. Pasta browsers local na raiz do projeto
    const localBrowsers = path.join(__dirname, 'browsers');
    if (fs.existsSync(localBrowsers)) {
        return localBrowsers;
    }

    // 4. Default Playwright (deixa o Playwright resolver se nada for encontrado)
    return undefined;
}

module.exports = {
    EXTERNAL_BASE_DIR,
    PDFS_DIR,
    JSON_DIR,
    AUTH_PATH,
    PBIX_PATH,
    getBrowsersPath
};
