/**
 * ============================================================================
 * MÓDULO DE AUTOMAÇÃO PLAYWRIGHT & EXTRAÇÃO DE CURRÍCULOS DO LINKEDIN
 * ============================================================================
 * Responsabilidades:
 *  1. Normalização de URLs do LinkedIn (extração de slug, protocolo, remoção de query params).
 *  2. Automação de navegador Chromium via Playwright usando sessão autenticada (auth.json).
 *  3. Acionamento do botão 'Mais' -> 'Salvar como PDF' nativo do LinkedIn.
 *  4. Interceptação do download e persistência do PDF na pasta 'pdfs/'.
 *  5. Extração de texto completo via 'pdf-parse' e persistência estruturada em 'dados_json/'.
 *  6. Reconstituição de URLs com quebras por hífen e limpeza de ruídos de paginação.
 *  7. Processamento em lote sequencial resiliente com callbacks de progresso para SSE.
 * ============================================================================
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const pdfModule = require("pdf-parse");
const { PDFS_DIR, JSON_DIR, AUTH_PATH, getBrowsersPath, getChromiumExecutablePath } = require("./paths");

const downloadFolder = PDFS_DIR;
const jsonFolder = JSON_DIR;

// Garante que o Playwright localize o Chromium embutido
const bundledBrowsersPath = getBrowsersPath();
if (bundledBrowsersPath && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsersPath;
}

/**
 * Retorna as opções padrão para inicialização do Chromium, apontando
 * diretamente para o chrome.exe real para evitar a busca pelo chrome-headless-shell
 */
function getLaunchOptions(overrides = {}) {
    const options = {
        headless: true,
        slowMo: 300,
        ...overrides
    };
    const explicitExe = getChromiumExecutablePath();
    if (explicitExe) {
        options.executablePath = explicitExe;
    }
    return options;
}

/**
 * Normaliza qualquer entrada de URL ou nome de perfil para o padrão oficial:
 * https://www.linkedin.com/in/{username}
 * 
 * @param {string} rawInput - URL bruta ou identificador inserido pelo usuário
 * @returns {string} URL limpa e padronizada
 */
function normalizeLinkedInUrl(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return '';
    let input = rawInput.trim();
    // Remove query strings (?...) e âncoras (#...)
    input = input.split('?')[0].split('#')[0].trim();
    input = input.replace(/\/+$/, '');

    // Se o usuário digitou apenas o username ou 'in/username'
    if (!input.includes('linkedin.com')) {
        const username = input.replace(/^(\/?in\/|\/)/, '').trim();
        return 'https://www.linkedin.com/in/' + username;
    }

    // Garante o protocolo https://
    if (!input.startsWith('http://') && !input.startsWith('https://')) {
        input = 'https://' + input;
    }

    try {
        const parsed = new URL(input);
        let pathname = parsed.pathname.replace(/\/+$/, '');
        // Garante que o caminho contenha /in/{slug}
        if (!pathname.startsWith('/in/')) {
            const parts = pathname.split('/').filter(p => p.length > 0);
            const inIdx = parts.indexOf('in');
            if (inIdx !== -1 && parts[inIdx + 1]) {
                pathname = '/in/' + parts[inIdx + 1];
            }
        }
        return 'https://www.linkedin.com' + pathname;
    } catch (e) {
        return input;
    }
}

/**
 * Extrai a URL do LinkedIn a partir do texto bruto extraído do PDF,
 * mesmo que tenha sido quebrada em múltiplas linhas pela coluna estreita de contato.
 * Exemplo: "www.linkedin.com/in/alan-\nmoura-8ba712170 (LinkedIn)" -> "https://www.linkedin.com/in/alan-moura-8ba712170"
 * 
 * @param {string} text - Texto bruto do PDF
 * @returns {string} URL reconstruída ou string vazia
 */
function extractLinkedInUrlFromText(text) {
    if (!text) return '';
    const match = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/\s*([^\s()]+)(?:\s*[\r\n]+\s*([^\s()]+))?/i);
    if (match) {
        let part1 = match[1];
        let part2 = match[2] || '';
        part2 = part2.replace(/\s*\(.*?\)/g, '').trim();
        let slug = part1;
        if (slug.endsWith('-')) {
            slug = slug + part2;
        } else if (part2 && !part2.toLowerCase().includes('linkedin') && !part2.includes('/')) {
            slug = slug + part2;
        }
        slug = slug.replace(/-+$/, '');
        return 'https://www.linkedin.com/in/' + slug;
    }
    return '';
}

/**
 * Lê o PDF salvo, extrai o texto com 'pdf-parse', reconstrói a URL se necessário,
 * limpa as quebras de linha com hífen e salva os dados estruturados em JSON.
 * 
 * @param {string} pdfFilePath - Caminho do arquivo PDF gravado
 * @param {Object} metadata - { personName, url, dateStr, fileName }
 * @returns {Promise<Object|null>} { jsonFileName, jsonFilePath }
 */
async function extractAndSaveJson(pdfFilePath, metadata) {
    try {
        const dataBuffer = fs.readFileSync(pdfFilePath);
        let rawText = '';
        let numPages = 1;

        // Suporte a diferentes versões e formatos de exportação da biblioteca pdf-parse
        if (pdfModule && pdfModule.PDFParse) {
            const parser = new pdfModule.PDFParse({ data: dataBuffer });
            const res = await parser.getText();
            if (res.pages && Array.isArray(res.pages)) {
                rawText = res.pages.map(p => p.text || '').join('\n');
            } else if (typeof res.text === 'string') {
                rawText = res.text;
            }
            numPages = res.total || (res.pages ? res.pages.length : 1);
        } else if (typeof pdfModule === 'function') {
            const parsed = await pdfModule(dataBuffer);
            rawText = parsed.text || '';
            numPages = parsed.numpages || 1;
        }

        // Recupera URL completa se a informada estiver vazia ou truncada com hífen
        let resolvedUrl = (metadata.url || '').trim();
        if (!resolvedUrl || resolvedUrl.endsWith('-') || resolvedUrl.endsWith('/in/')) {
            const fromText = extractLinkedInUrlFromText(rawText);
            if (fromText) resolvedUrl = fromText;
        }

        // Normaliza palavras/URLs quebradas com hífen no fim da linha
        const cleanedText = rawText.replace(/([a-zA-Z0-9])-[\r\n]+([a-zA-Z0-9])/g, '$1-$2');
        // Quebra em blocos ignorando linhas de paginação
        const textBlocks = cleanedText
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !/^Page\s+\d+\s+of\s+\d+/i.test(line));

        const resultJson = {
            profileName: metadata.personName,
            url: resolvedUrl,
            dataScraping: metadata.dateStr,
            pdfFile: metadata.fileName,
            meta: {
                num_paginas: numPages,
                total_blocos: textBlocks.length,
                total_caracteres: rawText.length
            },
            rawText: rawText,
            rawBlocks: textBlocks
        };

        if (!fs.existsSync(jsonFolder)) {
            fs.mkdirSync(jsonFolder, { recursive: true });
        }

        const jsonFileName = metadata.fileName.replace('.pdf', '.json');
        const jsonFilePath = path.join(jsonFolder, jsonFileName);
        fs.writeFileSync(jsonFilePath, JSON.stringify(resultJson, null, 2), 'utf-8');

        console.log('JSON gerado com sucesso: ' + jsonFileName);
        return { jsonFileName, jsonFilePath };
    } catch (error) {
        console.error('Erro ao extrair texto/metadados do PDF:', error.message);
        return null;
    }
}

/**
 * Realiza o scraping de um único perfil do LinkedIn dentro de um contexto existente do Playwright.
 * 
 * @param {import('playwright').BrowserContext} context - Contexto do navegador com autenticação
 * @param {string} rawUrl - URL do perfil a ser acessado
 * @returns {Promise<string>} Nome do arquivo PDF gerado
 */
async function scrapeSingleProfile(context, rawUrl) {
    const url = normalizeLinkedInUrl(rawUrl);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    try {
        console.log('Acessando: ' + url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Detecção de página não encontrada (perfil inexistente ou removido - erro 404)
        const isNotFound = await page.evaluate(() => {
            const bodyText = document.body ? document.body.innerText : '';
            const hasNotFoundText = bodyText.includes('Esta página não existe') || bodyText.includes('Page not found');
            const hasNotFoundMeta = !!document.querySelector('meta[content="d_flagship3_404"]') || !!document.querySelector('[data-sdui-screen*="NotFound"]');
            return hasNotFoundText || hasNotFoundMeta;
        });

        if (isNotFound) {
            console.log('[PULANDO] Página não encontrada (404): ' + url);
            throw new Error('Página não encontrada (404)');
        }

        // Clica no botão "Mais" no cabeçalho do perfil
        const moreBtn = page.getByTestId('lazy-column').getByRole('button', { name: 'Mais' });
        await moreBtn.waitFor({ state: 'visible', timeout: 10000 });
        await moreBtn.click();

        // Configura a captura do evento de download antes de clicar no botão
        const page1Promise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
        const downloadPromise = page.waitForEvent('download', { timeout: 25000 });

        // Clica em "Salvar como PDF"
        const savePdfBtn = page.getByText('Salvar como PDF');
        await savePdfBtn.waitFor({ state: 'visible', timeout: 10000 });
        await savePdfBtn.click();

        const download = await downloadPromise;

        // Extração do nome da pessoa a partir do título da página ou elemento H1
        let personName = 'Perfil';
        try {
            let pageTitle = await page.title();
            if (pageTitle) {
                pageTitle = pageTitle.replace(/^\([0-9]+\+?\)\s*/, '');
                if (pageTitle.includes('|')) {
                    personName = pageTitle.split('|')[0].trim();
                } else if (pageTitle.includes('-')) {
                    personName = pageTitle.split('-')[0].trim();
                } else {
                    personName = pageTitle.replace(/LinkedIn/gi, '').trim();
                }
            }
            if (!personName || personName.toLowerCase() === 'linkedin') {
                await page.waitForSelector('h1', { state: 'visible', timeout: 3000 }).catch(() => {});
                personName = await page.locator('h1').first().innerText();
            }
            personName = personName.trim().replace(/[^a-zA-Z0-9\u00C0\u00FF\s]/g, '');
            if (!personName) personName = 'Perfil';
        } catch (e) {
            console.log('Não foi possível extrair o nome. Usando nome padrão.');
        }

        // Geração do nome do arquivo com timestamp e sufixo único
        const dateObj = new Date();
        const dateStr = String(dateObj.getDate()).padStart(2, '0') + '-' + String(dateObj.getMonth() + 1).padStart(2, '0') + '-' + dateObj.getFullYear();
        const uniqueId = Date.now().toString().slice(-4);
        const fileName = personName.replace(/\s+/g, '_') + '_' + dateStr + '_' + uniqueId + '.pdf';

        if (!fs.existsSync(downloadFolder)) {
            fs.mkdirSync(downloadFolder, { recursive: true });
        }

        // Salva o PDF no disco
        const filePath = path.join(downloadFolder, fileName);
        await download.saveAs(filePath);
        await page.waitForTimeout(500);

        // Extrai texto e salva JSON correspondente
        await extractAndSaveJson(filePath, {
            personName,
            url,
            dateStr,
            fileName
        });

        return fileName;
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * Executa o scraping de um único perfil isoladamente, iniciando e encerrando o navegador.
 * 
 * @param {string} url - URL ou slug do perfil do LinkedIn
 * @returns {Promise<string>} Nome do arquivo PDF gerado
 */
async function scrapeProfile(url) {
    const browser = await chromium.launch(getLaunchOptions());

    const authPath = AUTH_PATH;
    if (!fs.existsSync(authPath)) {
        await browser.close().catch(() => {});
        throw new Error("auth.json não encontrado. Faça o login primeiro usando auth.js.");
    }

    const context = await browser.newContext({
        storageState: authPath,
        acceptDownloads: true
    });

    try {
        return await scrapeSingleProfile(context, url);
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

/**
 * Executa o scraping em lote sequencialmente para uma lista de URLs,
 * reaproveitando o mesmo contexto de navegador para alta performance.
 * Emite callbacks para streaming de eventos em tempo real via Server-Sent Events (SSE).
 * 
 * @param {Array<string>} urls - Lista de URLs a processar
 * @param {Function} [onProgress] - Callback opcional para notificação de progresso
 * @returns {Promise<Array<Object>>} Lista de resultados por URL
 */
async function scrapeBatch(urls, onProgress) {
    const browser = await chromium.launch(getLaunchOptions());

    const authPath = AUTH_PATH;
    if (!fs.existsSync(authPath)) {
        await browser.close().catch(() => {});
        throw new Error("auth.json não encontrado. Faça o login primeiro usando auth.js.");
    }

    const context = await browser.newContext({
        storageState: authPath,
        acceptDownloads: true
    });

    const results = [];

    try {
        for (let i = 0; i < urls.length; i++) {
            const rawUrl = urls[i];
            console.log(`\n[${i + 1}/${urls.length}] Iniciando processamento de: ${rawUrl}`);

            if (onProgress) {
                onProgress({
                    index: i,
                    url: rawUrl,
                    status: 'processing'
                });
            }

            try {
                const fileName = await scrapeSingleProfile(context, rawUrl);
                const itemResult = {
                    index: i,
                    url: rawUrl,
                    success: true,
                    fileName: fileName
                };
                results.push(itemResult);

                if (onProgress) {
                    onProgress({
                        ...itemResult,
                        status: 'success'
                    });
                }
            } catch (error) {
                console.error(`[FALHA] Não foi possível raspar ${rawUrl}:`, error.message);
                const itemResult = {
                    index: i,
                    url: rawUrl,
                    success: false,
                    error: error.message
                };
                results.push(itemResult);

                if (onProgress) {
                    onProgress({
                        ...itemResult,
                        status: 'failed'
                    });
                }
            }

            // Pequena pausa preventiva entre requisições consecutivas
            if (i < urls.length - 1) {
                console.log('Aguardando 2 segundos antes do próximo perfil...');
                await new Promise(res => setTimeout(res, 2000));
            }
        }
        return results;
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

module.exports = { normalizeLinkedInUrl, scrapeProfile, scrapeBatch, extractAndSaveJson };