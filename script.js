const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const pdfModule = require("pdf-parse");

const downloadFolder = path.join(__dirname, 'pdfs');
const jsonFolder = path.join(__dirname, 'dados_json');

function normalizeLinkedInUrl(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return '';
    let input = rawInput.trim();
    input = input.split('?')[0].split('#')[0].trim();
    input = input.replace(/\/+$/, '');
    if (!input.includes('linkedin.com')) {
        const username = input.replace(/^(\/?in\/|\/)/, '').trim();
        return 'https://www.linkedin.com/in/' + username;
    }
    if (!input.startsWith('http://') && !input.startsWith('https://')) {
        input = 'https://' + input;
    }
    try {
        const parsed = new URL(input);
        let pathname = parsed.pathname.replace(/\/+$/, '');
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

async function extractAndSaveJson(pdfFilePath, metadata) {
    try {
        const dataBuffer = fs.readFileSync(pdfFilePath);
        let rawText = '';
        let numPages = 1;
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

        const textBlocks = rawText
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const resultJson = {
            profileName: metadata.personName,
            url: metadata.url,
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

async function scrapeSingleProfile(context, rawUrl) {
    const url = normalizeLinkedInUrl(rawUrl);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    try {
        console.log('Acessando: ' + url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
        const moreBtn = page.getByTestId('lazy-column').getByRole('button', { name: 'Mais' });
        await moreBtn.waitFor({ state: 'visible', timeout: 10000 });
        await moreBtn.click();
        const page1Promise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
        const downloadPromise = page.waitForEvent('download', { timeout: 25000 });
        const savePdfBtn = page.getByText('Salvar como PDF');
        await savePdfBtn.waitFor({ state: 'visible', timeout: 10000 });
        await savePdfBtn.click();
        const download = await downloadPromise;
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
        const dateObj = new Date();
        const dateStr = String(dateObj.getDate()).padStart(2, '0') + '-' + String(dateObj.getMonth() + 1).padStart(2, '0') + '-' + dateObj.getFullYear();
        const uniqueId = Date.now().toString().slice(-4);
        const fileName = personName.replace(/\s+/g, '_') + '_' + dateStr + '_' + uniqueId + '.pdf';
        if (!fs.existsSync(downloadFolder)) {
            fs.mkdirSync(downloadFolder, { recursive: true });
        }
        const filePath = path.join(downloadFolder, fileName);
        await download.saveAs(filePath);
        await page.waitForTimeout(500);
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

async function scrapeProfile(url) {
    const browser = await chromium.launch({
        headless: true,
        slowMo: 300,
    });
    const authPath = path.join(__dirname, "auth.json");
    if (!fs.existsSync(authPath)) {
        await browser.close().catch(() => {});
        throw new Error("auth.json não encontrado. Faca o login primeiro usando auth.js.");
        }
    const context = await browser.newContext({
        storageState: authPath
    });
    try {
        const fileName = await scrapeSingleProfile(context, url);
        return fileName;
    } finally {
        await browser.close().catch(() => {});
    }
}

async function scrapeBatch(urls, onProgress = null) {
    const browser = await chromium.launch({
        headless: true,
        slowMo: 300,
    });
    const authPath = path.join(__dirname, "auth.json");
    if (!fs.existsSync(authPath)) {
        await browser.close().catch(() => {});
        throw new Error("auth.json não encontrado. Faça o login primeiro usando auth.js.");
    }
    const context = await browser.newContext({
        storageState: authPath
    });
    const results = [];
    try {
        for (let i = 0; i < urls.length; i++) {
            const rawUrl = urls[i];
            const url = normalizeLinkedInUrl(rawUrl);
            if (typeof onProgress === 'function') {
                onProgress({ index: i, total: urls.length, url, status: 'processing' });
            }
            try {
                const fileName = await scrapeSingleProfile(context, url);
                const item = { url, success: true, fileName };
                results.push(item);
                if (typeof onProgress === 'function') {
                    onProgress({ 
                        index: i, 
                        total: urls.length, 
                        url, 
                        status: 'success', 
                        fileName, 
                        downloadUrl: '/downloads/' + fileName 
                    });
                }
            } catch (error) {
                let cleanError = error.message || 'Erro desconhecido';
                if (cleanError.includes('Timeout') || cleanError.includes('timeout')) {
                    cleanError = 'Tempo limite de 30s excedido';
                }
                console.error('[AVISO] Falha no link ' + (i + 1) + '/' + urls.length + ' (' + url + '): ' + cleanError);
                const item = { url, success: false, error: cleanError };
                results.push(item);
                if (typeof onProgress === 'function') {
                    onProgress({ 
                        index: i, 
                        total: urls.length, 
                        url, 
                        status: 'failed', 
                        error: cleanError 
                    });
                }
            }
            if (i < urls.length - 1) {
                const delay = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
                const ded = delay / 1000;
                console.log('Aguardando ' + ded + 's antes do proximo link...');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        return results;
        } finally {
        await browser.close().catch(() => {});
    }
}

module.exports = { normalizeLinkedInUrl, scrapeProfile, scrapeBatch, extractAndSaveJson };