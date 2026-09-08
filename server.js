/**
 * ============================================================================
 * SERVIDOR PRINCIPAL - LINKEDIN PROFILE SCRAPER & PBIX SEMANTIC EXPLORER
 * ============================================================================
 * Aplicação Express que fornece:
 *  1. Endpoints de Web Scraping (Individual e em Lote via SSE) usando Playwright.
 *  2. Endpoints de Modelo Semântico e Registro de Dados raspados do LinkedIn.
 *  3. Endpoints do Explorador de Tabela Real do arquivo Power BI (.pbix),
 *     decodificando o motor VertiPaq/XPress9 em tempo real sem dependências externas.
 *  4. Servidor de arquivos estáticos (HTML/CSS/JS, PDFs gerados e dados JSON).
 * ============================================================================
 */

const express = require('express');
const path = require('path');
const { normalizeLinkedInUrl, scrapeProfile, scrapeBatch } = require('./script');
const { 
    getSemanticModel, 
    getEgressosPeople, 
    getBaseBiData, 
    getPbixRealTable,
    exportPbixRealTableToCsv,
    exportProfilesToCsv 
} = require('./pbixHandler');

const { PDFS_DIR, JSON_DIR } = require('./paths');
const { PDFS_DIR, JSON_DIR, PBIX_PATH } = require('./paths');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Caminho configurável para o arquivo Power BI (.pbix).
 * Pode ser sobrescrito através da variável de ambiente PBIX_FILE_PATH.
 * Prioridade: PBIX_FILE_PATH do ambiente > PBIX_PATH externo > padrão interno
 */
const PBIX_FILE_PATH = process.env.PBIX_FILE_PATH || path.join(__dirname, 'egressos.pbix');
const PBIX_FILE_PATH = process.env.PBIX_FILE_PATH || PBIX_PATH;

// Middlewares para parsing de JSON e serviço de diretórios estáticos
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(PDFS_DIR));
app.use('/json', express.static(JSON_DIR));

// ============================================================================
// ROTAS DO MODELO SEMÂNTICO & EXPLORADOR PBIX
// ============================================================================

/**
 * GET /api/pbix/model
 * Retorna os metadados do modelo semântico do arquivo .pbix configurado:
 * tamanho, data de modificação, tabelas mapeadas, colunas e páginas do relatório.
 */
app.get('/api/pbix/model', (req, res) => {
    try {
        const model = getSemanticModel(PBIX_FILE_PATH);
        res.json({
            success: true,
            model: model
        });
    } catch (error) {
        console.error('Erro ao ler modelo semântico do PBIX:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Erro ao extrair modelo semântico do arquivo PBIX.'
        });
    }
});

/**
 * GET /api/pbix/table-data
 * Retorna os registros da aba "Registro de Dados" (dados coletados dos perfis raspados do LinkedIn).
 * Inclui os metadados de colunas ativas e o total de perfis analisados.
 */
app.get('/api/pbix/table-data', (req, res) => {
    try {
        const model = getSemanticModel(PBIX_FILE_PATH);
        const data = getBaseBiData();
        res.json({
            success: true,
            table: model.primaryTable || 'BASE BI',
            headers: model.primaryHeaders || [],
            columns: model.columns || [],
            totalRows: data.length,
            rows: data
        });
    } catch (error) {
        console.error('Erro ao obter dados da tabela do PBIX:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Erro ao carregar dados da tabela do PBIX.'
        });
    }
});

/**
 * GET /api/pbix/real-table
 * Retorna a tabela REAL extraída diretamente do DataModel compactado dentro do .pbix
 * decodificada pelo motor VertiPaq/XPress9 (todas as colunas e todas as linhas reais).
 */
app.get('/api/pbix/real-table', async (req, res) => {
    try {
        const tableData = await getPbixRealTable(PBIX_FILE_PATH);
        res.json({
            success: tableData.success,
            table: tableData.tableName,
            columns: tableData.columns,
            rowCount: tableData.rowCount,
            rows: tableData.rows
        });
    } catch (error) {
        console.error('Erro ao extrair tabela real do PBIX:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Erro ao extrair tabela interna do PBIX.'
        });
    }
});

/**
 * GET /api/pbix/people
 * Retorna a lista simplificada de egressos e pessoas para consumo rápido de API.
 */
app.get('/api/pbix/people', (req, res) => {
    try {
        const people = getEgressosPeople();
        res.json({
            success: true,
            total: people.length,
            people: people
        });
    } catch (error) {
        console.error('Erro ao obter lista de pessoas:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Erro ao carregar lista de egressos.'
        });
    }
});

/**
 * GET /api/pbix/export-csv
 * Gera e faz o download de um arquivo CSV formatado para Power BI contendo os dados coletados.
 */
app.get('/api/pbix/export-csv', (req, res) => {
    try {
        const csvPath = exportProfilesToCsv();
        res.download(csvPath, 'perfis_linkedin_powerbi.csv');
    } catch (error) {
        console.error('Erro ao exportar CSV:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Erro ao exportar arquivo CSV.'
        });
    }
});

/**
 * GET /api/pbix/export-real-csv
 * Gera e faz o download de um arquivo CSV contendo a tabela real BASE BI extraída do .pbix (321 linhas).
 */
app.get('/api/pbix/export-real-csv', async (req, res) => {
    try {
        const csvPath = await exportPbixRealTableToCsv(PBIX_FILE_PATH);
        res.download(csvPath, 'BASE_BI_real_powerbi.csv');
    } catch (error) {
        console.error('Erro ao exportar CSV real:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Erro ao exportar arquivo CSV real.'
        });
    }
});

// ============================================================================
// ROTAS DE SCRAPING DO LINKEDIN (PLAYWRIGHT)
// ============================================================================

/**
 * POST /api/scrape
 * Executa o scraping de um único perfil do LinkedIn.
 * Salva o currículo em PDF e extrai os dados estruturados em JSON.
 */
app.post('/api/scrape', async (req, res) => {
    let { url } = req.body;
    if (!url || typeof url !== 'string' || url.trim().length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Por favor, forneça uma URL ou nome de perfil válido do LinkedIn.'
        });
    }
    url = normalizeLinkedInUrl(url);
    try {
        console.log('Iniciando scraping para: ' + url);
        const fileName = await scrapeProfile(url);
        console.log('Scraping concluído com sucesso. Arquivo: ' + fileName);
        res.json({
            success: true,
            fileName: fileName,
            downloadUrl: '/downloads/' + fileName
        });
    } catch (error) {
        console.error('Erro durante o scraping:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Ocorreu um erro interno durante o scraping.'
        });
    }
});

/**
 * POST /api/scrape-batch-stream
 * Executa o scraping de múltiplos perfis em lote usando Server-Sent Events (SSE).
 * Fornece feedback em tempo real para a barra de progresso e itens da fila no frontend.
 */
app.post('/api/scrape-batch-stream', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Por favor, forneça uma lista válida de URLs.'
        });
    }
    const normalizedUrls = urls.map(u => normalizeLinkedInUrl(u)).filter(u => u.length > 0);

    // Cabeçalhos HTTP para transmissão contínua de eventos (SSE)
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (res.flushHeaders) res.flushHeaders();

    const sendEvent = (data) => {
        res.write('data: ' + JSON.stringify(data) + '\n\n');
        if (typeof res.flush === 'function') res.flush();
    };

    try {
        console.log('Iniciando streaming em lote para ' + normalizedUrls.length + ' perfis.');
        sendEvent({ type: 'start', total: normalizedUrls.length, urls: normalizedUrls });

        // Executa o processamento em lote emitindo eventos de progresso item a item
        const results = await scrapeBatch(normalizedUrls, (eventData) => {
            sendEvent({ type: 'progress', ...eventData });
        });

        console.log('Scraping em lote finalizado.');
        sendEvent({
            type: 'complete',
            total: normalizedUrls.length,
            successCount: results.filter(r => r.success).length,
            failCount: results.filter(r => !r.success).length,
            results: results.map(r => ({
                ...r,
                downloadUrl: r.success ? ('/downloads/' + r.fileName) : null
            }))
        });
        res.end();
    } catch (error) {
        console.log('Erro fatal no streaming em lote:', error);
        sendEvent({ type: 'fatal_error', error: error.message });
        res.end();
    }
});

/**
 * POST /api/scrape-batch
 * Endpoint legado síncrono para processamento em lote sem streaming.
 */
app.post('/api/scrape-batch', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) { 
        return res.status(400).json({
            success: false,
            error: 'Por favor, forneça uma lista válida de URLs.'
        });
    }
    const normalizedUrls = urls.map(u => normalizeLinkedInUrl(u)).filter(u => u.length > 0);
    try {
        console.log('Iniciando scraping em lote para ' + normalizedUrls.length + ' perfis.');
        const results = await scrapeBatch(normalizedUrls);
        console.log('Scraping em lote concluído.');
        res.json({
            success: true,
            results: results.map(r => ({
                ...r,
                downloadUrl: r.success ? ('/downloads/' + r.fileName) : null
            }))
        });
    } catch (error) {
        console.log('Erro durante o scraping em lote:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Ocorreu um erro interno durante o scraping em lote.'
        });
    }
});

// ============================================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================================
app.listen(PORT, () => {
    console.log('Servidor rodando na porta ' + PORT);
    console.log('Arquivo PBIX configurado: ' + PBIX_FILE_PATH);
    console.log('Acesse http://localhost:' + PORT + ' no seu navegador.');
});
