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
 * Extrai fielmente todas as experiências profissionais contidas no perfil
 * (cargos, empresas, datas de entrada e saída, estágios, descrições verbatim),
 * sem inferência ou descarte de dados.
 * 
 * @param {string} rawText - Texto bruto do PDF
 * @returns {string} Bloco completo de experiências
 */
function extractExperienceFromText(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    const cleaned = rawText.replace(/Page\s+\d+\s+of\s+\d+/gi, '').replace(/\r\n/g, '\n');
    const match = cleaned.match(/(?:^|\n)(?:Experiência|Experience|Expérience|Experiencia)\s*\n([\s\S]*?)(?=\n(?:Formação acadêmica|Formação|Formation|Educação|Education|Educación|Competências|Skills|Compétences|Competencias|Licenças e certificados|Licenses & certifications|Licences et certifications|Idiomas|Languages|Langues|Cursos|Courses|Recomendações|Recommendations|Projetos|Projects|Projets|Publicações|Publications|Prêmios|Honors & awards|Organizações|Organizations)|$)/i);
    if (match && match[1]) {
        return match[1].trim();
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

        // Extração fiel de experiências profissionais sem inferência de dados
        const experienciaProfissional = extractExperienceFromText(rawText);

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
            experienciaProfissional: experienciaProfissional,
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
 * Salva os dados estruturados do perfil diretamente em JSON na pasta dados_json/.
 * 
 * @param {Object} metadata - { personName, url, dateStr, fileName, experienciaProfissional }
 * @returns {Object} { jsonFileName, jsonFilePath }
 */
function saveProfileDirectJson(metadata) {
    if (!fs.existsSync(jsonFolder)) {
        fs.mkdirSync(jsonFolder, { recursive: true });
    }

    const jsonFileName = metadata.fileName;
    const jsonFilePath = path.join(jsonFolder, jsonFileName);

    const resultJson = {
        profileName: metadata.personName,
        url: metadata.url,
        dataScraping: metadata.dateStr,
        pdfFile: null,
        meta: {
            modo_extracao: 'DOM_DIRECT',
            total_caracteres: (metadata.experienciaProfissional || '').length
        },
        experienciaProfissional: metadata.experienciaProfissional || '',
        rawText: metadata.experienciaProfissional || ''
    };

    fs.writeFileSync(jsonFilePath, JSON.stringify(resultJson, null, 2), 'utf-8');
    console.log('JSON gerado com sucesso: ' + jsonFileName);
    return { jsonFileName, jsonFilePath };
}

/**
 * Realiza o scraping de um único perfil do LinkedIn dentro de um contexto existente do Playwright,
 * extraindo as informações profissionais diretamente do DOM da página sem depender de PDF.
 * 
 * @param {import('playwright').BrowserContext} context - Contexto do navegador com autenticação
 * @param {string} rawUrl - URL do perfil a ser acessado
 * @returns {Promise<string>} Nome do arquivo JSON gerado
 */
async function scrapeSingleProfile(context, rawUrl) {
    const url = normalizeLinkedInUrl(rawUrl);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    try {
        console.log('Acessando perfil: ' + url);
        // Primeiro acessa a página do perfil para validar existência e extrair nome
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000);

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
                const h1 = await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '');
                if (h1 && h1.trim()) personName = h1.trim();
            }
            personName = personName.trim().replace(/[^\p{L}\p{N}\s]/gu, '');
            if (!personName || personName.toLowerCase() === 'linkedin') {
                let rawSlug = url.split('/').pop().replace(/-[0-9a-f]+$/, '');
                try { rawSlug = decodeURIComponent(rawSlug); } catch (e) {}
                const slug = rawSlug.replace(/-/g, ' ');
                personName = slug.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
        } catch (e) {
            console.log('Não foi possível extrair o nome. Usando fallback.');
        }

        // Navega diretamente para a seção completa de experiências do LinkedIn (/details/experience/)
        const detailsExpUrl = url.replace(/\/+$/, '') + '/details/experience/';
        console.log('Acessando experiências completas via: ' + detailsExpUrl);
        await page.goto(detailsExpUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);

        // Extrai fielmente todas as experiências do DOM
        const experienciaProfissional = await page.evaluate(() => {
            const main = document.querySelector('main') || document.body;
            if (!main) return '';

            const sections = Array.from(main.querySelectorAll('section'));
            let expSection = sections.find(s => {
                const h = s.querySelector('h1, h2, h3, span.visually-hidden');
                const txt = (h ? h.innerText : (s.innerText || '')).slice(0, 80);
                return /experiência|experience/i.test(txt);
            });

            if (!expSection && window.location.href.includes('/details/experience/')) {
                expSection = sections[0];
            }

            if (!expSection) return '';

            let text = expSection.innerText || '';

            // Se for estado vazio (sem experiências cadastradas)
            if (text.includes('Nada para ver por enquanto') || 
                text.includes('Nothing to see for now') || 
                text.includes('Nenhuma experiência adicionada')) {
                return '';
            }

            // Remove o cabeçalho 'Experiência' / 'Experience'
            text = text.replace(/^(Experiência|Experience)\s*\n+/i, '').trim();

            // Remove sugestões de pessoas ou rodapé que possam ter entrado
            const cutKeywords = [
                'Mais perfis para você',
                'Pessoas que talvez você conheça',
                'People also viewed',
                'Sobre\nAcessibilidade'
            ];
            for (const kw of cutKeywords) {
                const kwIdx = text.indexOf(kw);
                if (kwIdx !== -1) {
                    text = text.substring(0, kwIdx).trim();
                }
            }

            // Normaliza quebras de linha excessivas
            text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
            return text;
        });

        // Geração do nome do arquivo JSON com timestamp e sufixo único
        const dateObj = new Date();
        const dateStr = String(dateObj.getDate()).padStart(2, '0') + '-' + String(dateObj.getMonth() + 1).padStart(2, '0') + '-' + dateObj.getFullYear();
        const uniqueId = Date.now().toString().slice(-4);
        const fileName = personName.replace(/\s+/g, '_') + '_' + dateStr + '_' + uniqueId + '.json';

        // Salva os dados no disco em dados_json/
        saveProfileDirectJson({
            personName,
            url,
            dateStr,
            fileName,
            experienciaProfissional
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
 * @param {Object} [options] - Opções de execução { headless: boolean }
 * @returns {Promise<string>} Nome do arquivo PDF gerado
 */
async function scrapeProfile(url, options = {}) {
    const headless = options.headless !== undefined ? options.headless : true;
    const browser = await chromium.launch(getLaunchOptions({ headless }));


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
 * @param {Object} [options] - Opções de execução { headless: boolean, delaySeconds: number }
 * @returns {Promise<Array<Object>>} Lista de resultados por URL
 */
async function scrapeBatch(urls, onProgress, options = {}) {
    const headless = options.headless !== undefined ? options.headless : true;
    const delaySeconds = typeof options.delaySeconds === 'number' && options.delaySeconds >= 0 ? options.delaySeconds : 2;
    const browser = await chromium.launch(getLaunchOptions({ headless }));


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
            // Pausa preventiva configurável entre requisições consecutivas
            if (i < urls.length - 1 && delaySeconds > 0) {
                console.log(`Aguardando ${delaySeconds} segundo(s) antes do próximo perfil...`);
                await new Promise(res => setTimeout(res, delaySeconds * 1000));
            }
        }
        return results;
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

module.exports = { 
    normalizeLinkedInUrl, 
    scrapeProfile, 
    scrapeBatch, 
    extractAndSaveJson,
    extractExperienceFromText,
    saveProfileDirectJson
};