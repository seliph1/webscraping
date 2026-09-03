const express = require('express');
const path = require('path');
const { normalizeLinkedInUrl, scrapeProfile, scrapeBatch } = require('./script');
const { getSemanticModel, getEgressosPeople, getBaseBiData, exportProfilesToCsv } = require('./pbixHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Variável que define o arquivo Power BI (.pbix) a ser aberto
const PBIX_FILE_PATH = process.env.PBIX_FILE_PATH || path.join(__dirname, 'egressos.pbix');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(path.join(__dirname, 'pdfs')));
app.use('/json', express.static(path.join(__dirname, 'dados_json')));

// Endpoint para obter o modelo semântico do arquivo PBIX configurado
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

// Endpoint para obter os dados completos da tabela do .pbix (BASE BI)
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

// Endpoint para obter a lista de pessoas/egressos
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

// Endpoint para baixar o CSV exportado para Power BI
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

app.post('/api/scrape-batch-stream', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Por favor, forneça uma lista válida de URLs.'
        });
    }
    const normalizedUrls = urls.map(u => normalizeLinkedInUrl(u)).filter(u => u.length > 0);
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

app.listen(PORT, () => {
    console.log('Servidor rodando na porta ' + PORT);
    console.log('Arquivo PBIX configurado: ' + PBIX_FILE_PATH);
    console.log('Acesse http://localhost:' + PORT + ' no seu navegador.');
});
