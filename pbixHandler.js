const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

/**
 * Módulo para leitura, inspeção e modificação de arquivos Power BI (.pbix)
 * e extração de dados do modelo semântico de egressos.
 */

/**
 * Lista o conteúdo interno de um arquivo .pbix (ZIP interno)
 * @param {string} pbixFilePath - Caminho para o arquivo .pbix
 * @returns {Array<string>} Lista dos caminhos dos arquivos internos
 */
function inspectPbix(pbixFilePath) {
    if (!fs.existsSync(pbixFilePath)) {
        throw new Error(`Arquivo .pbix não encontrado: ${pbixFilePath}`);
    }
    const zip = new AdmZip(pbixFilePath);
    const zipEntries = zip.getEntries();
    return zipEntries.map(entry => entry.entryName);
}

/**
 * Extrai o arquivo de layout do relatório (Report/Layout) de dentro do .pbix
 * @param {string} pbixFilePath - Caminho para o arquivo .pbix
 * @returns {Object} Objeto JSON com o layout completo do relatório
 */
function getReportLayout(pbixFilePath) {
    if (!fs.existsSync(pbixFilePath)) {
        throw new Error(`Arquivo .pbix não encontrado: ${pbixFilePath}`);
    }
    const zip = new AdmZip(pbixFilePath);
    const layoutEntry = zip.getEntry('Report/Layout');
    
    if (!layoutEntry) {
        throw new Error('Arquivo Report/Layout não encontrado dentro do .pbix.');
    }
    
    let content = layoutEntry.getData().toString('utf16le');
    if (!content.trim().startsWith('{')) {
        content = layoutEntry.getData().toString('utf8');
    }
    
    return JSON.parse(content);
}

/**
 * Salva um novo layout alterado de volta para um arquivo .pbix
 * @param {string} sourcePbixPath - Caminho do .pbix original
 * @param {Object} newLayoutObj - Objeto do layout modificado
 * @param {string} targetPbixPath - Caminho onde o novo .pbix será salvo
 */
function savePbixLayout(sourcePbixPath, newLayoutObj, targetPbixPath) {
    if (!fs.existsSync(sourcePbixPath)) {
        throw new Error(`Arquivo .pbix original não encontrado: ${sourcePbixPath}`);
    }
    const zip = new AdmZip(sourcePbixPath);
    
    const layoutJsonString = JSON.stringify(newLayoutObj);
    const buffer = Buffer.from(layoutJsonString, 'utf16le');
    
    zip.updateFile('Report/Layout', buffer);
    zip.writeZip(targetPbixPath);
    console.log(`.pbix atualizado com sucesso em: ${targetPbixPath}`);
}

/**
 * Obtém os registros detalhados estruturados correspondentes à tabela BASE BI
 * mapeando os dados de egressos extraídos para os campos do Power BI.
 * @returns {Array<Object>} Lista de registros estruturados
 */
function getBaseBiData() {
    const jsonFolder = path.join(__dirname, 'dados_json');
    const records = [];
    const seen = new Set();

    if (!fs.existsSync(jsonFolder)) return records;

    const files = fs.readdirSync(jsonFolder).filter(f => f.endsWith('.json'));

    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(jsonFolder, file), 'utf8'));
            let name = (data.profileName || data.nome_perfil || '').trim();
            let url = (data.url || '').trim();
            let headline = '';
            let location = '';
            let empresa = '';
            let cargo = '';
            let area = '';

            if (name.toLowerCase().includes('teste')) continue;

            const blocks = data.rawBlocks || [];

            // Recupera URL do perfil
            if (!url) {
                const inIdx = blocks.findIndex(b => b.includes('linkedin.com/in/'));
                if (inIdx !== -1) {
                    let u = blocks[inIdx];
                    if (blocks[inIdx + 1] && !blocks[inIdx + 1].includes('LinkedIn') && !blocks[inIdx + 1].includes(' ')) {
                        u += blocks[inIdx + 1];
                    }
                    u = u.replace(/\s*\([^)]*\)/, '').trim();
                    if (!u.startsWith('http')) u = 'https://' + u;
                    url = u;
                }
            }

            // Recupera nome completo
            if (!name.includes(' ')) {
                const candidate = blocks.find(b => b.startsWith(name + ' ') && b.split(' ').length >= 2 && b.length < 50);
                if (candidate) name = candidate;
            }

            // Ajusta acentuação
            name = name
                .replace(/^Letcia\b/, 'Letícia')
                .replace(/\bFrazo\b/, 'Frazão')
                .replace(/\bBencio\b/, 'Benício')
                .replace(/\bLivia\b/, 'Lívia');

            // Chave única para deduplicação
            const key = (url || name).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            // Extrai headline e localização
            const nameIdx = blocks.indexOf(name);
            if (nameIdx !== -1) {
                if (blocks[nameIdx + 1] && !blocks[nameIdx + 1].includes('Page') && !blocks[nameIdx + 1].startsWith('http') && blocks[nameIdx + 1] !== '--') {
                    headline = blocks[nameIdx + 1];
                }
                if (blocks[nameIdx + 2] && !blocks[nameIdx + 2].includes('Page') && !blocks[nameIdx + 2].includes('Resumo') && !blocks[nameIdx + 2].includes('Experiência') && !blocks[nameIdx + 2].startsWith('Contato')) {
                    location = blocks[nameIdx + 2];
                }
            }

            // Extrai Empresa e Cargo a partir do headline
            if (headline) {
                const matchNa = headline.match(/(?:na|no|at|em)\s+([A-Za-z0-9\s&.-]+)/i);
                if (matchNa) {
                    empresa = matchNa[1].split('|')[0].trim();
                }
                const parts = headline.split('|').map(p => p.trim());
                cargo = parts[0];
                if (cargo.includes(' na ')) cargo = cargo.split(' na ')[0].trim();
                if (cargo.includes(' no ')) cargo = cargo.split(' no ')[0].trim();
            }

            // Fallback para seção Experiência
            const expIdx = blocks.indexOf('Experiência');
            if (expIdx !== -1 && blocks[expIdx + 1]) {
                if (!empresa) empresa = blocks[expIdx + 1];
                if (!cargo && blocks[expIdx + 2]) cargo = blocks[expIdx + 2];
                if (!location && blocks[expIdx + 4] && blocks[expIdx + 4].includes('Brasil')) {
                    location = blocks[expIdx + 4];
                }
            }

            // Classificação da Área
            const hLower = (headline + ' ' + cargo + ' ' + (data.rawText || '')).toLowerCase();
            if (hLower.includes('dados') || hLower.includes('data') || hLower.includes('bi ') || hLower.includes('sql') || hLower.includes('analyst')) {
                area = 'Análise de Dados / BI';
            } else if (hLower.includes('finance') || hLower.includes('controladoria') || hLower.includes('investimento') || hLower.includes('risco')) {
                area = 'Finanças & Controladoria';
            } else if (hLower.includes('rh') || hLower.includes('recursos humanos') || hLower.includes('talento') || hLower.includes('remunera')) {
                area = 'Recursos Humanos';
            } else if (hLower.includes('software') || hLower.includes('developer') || hLower.includes('devops') || hLower.includes('program') || hLower.includes('docker')) {
                area = 'Tecnologia / Desenvolvimento';
            } else if (hLower.includes('marketing') || hLower.includes('venda') || hLower.includes('comercial') || hLower.includes('e-commerce')) {
                area = 'Comercial & Marketing';
            } else if (hLower.includes('administra') || hLower.includes('projetos') || hLower.includes('gest')) {
                area = 'Administração & Gestão';
            } else {
                area = 'Administração Geral';
            }

            records.push({
                'Nomes': name || 'Não informado',
                'Cargo': cargo || headline || 'Não informado',
                'Empresa': empresa || 'CEFET-MG / Geral',
                'Área': area,
                'Região (Cidade)': location || 'Rio de Janeiro e Região, Brasil',
                'Coleta de Dados': data.dataScraping || data.data_scraping || '01-09-2026',
                'STATUS': 'Analisado',
                'url': url || '',
                'pdfFile': data.pdfFile || data.arquivo_pdf || null,
                'numPaginas': (data.meta && data.meta.num_paginas) || 1
            });
        } catch (e) {}
    }

    return records.sort((a, b) => a['Nomes'].localeCompare(b['Nomes'], 'pt-BR'));
}

/**
 * Extrai os metadados do modelo semântico (tabelas, colunas, páginas e visuais) de um .pbix
 * @param {string} pbixFilePath - Caminho para o arquivo .pbix
 * @returns {Object} Estrutura com metadados do modelo semântico e dados da tabela
 */
function getSemanticModel(pbixFilePath) {
    if (!fs.existsSync(pbixFilePath)) {
        return {
            exists: false,
            filePath: pbixFilePath,
            fileName: path.basename(pbixFilePath),
            error: 'Arquivo .pbix não encontrado no caminho configurado.'
        };
    }

    const stats = fs.statSync(pbixFilePath);
    const zip = new AdmZip(pbixFilePath);

    const tables = new Set();
    const columns = new Set();
    let sections = [];
    let metadata = {};

    // 1. Tentar ler DiagramLayout
    const diagramEntry = zip.getEntry('DiagramLayout');
    if (diagramEntry) {
        try {
            let str = diagramEntry.getData().toString('utf16le');
            if (!str.trim().startsWith('{')) str = diagramEntry.getData().toString('utf8');
            const d = JSON.parse(str);
            if (d.diagrams && Array.isArray(d.diagrams)) {
                d.diagrams.forEach(diag => {
                    if (diag.nodes && Array.isArray(diag.nodes)) {
                        diag.nodes.forEach(n => {
                            if (n.nodeIndex && typeof n.nodeIndex === 'string') {
                                tables.add(n.nodeIndex);
                            }
                        });
                    }
                });
            }
        } catch (e) {}
    }

    // 2. Ler Metadata
    const metaEntry = zip.getEntry('Metadata');
    if (metaEntry) {
        try {
            let str = metaEntry.getData().toString('utf16le');
            if (!str.trim().startsWith('{')) str = metaEntry.getData().toString('utf8');
            metadata = JSON.parse(str);
        } catch (e) {}
    }

    // 3. Ler Report/Layout
    const layoutEntry = zip.getEntry('Report/Layout');
    if (layoutEntry) {
        try {
            let str = layoutEntry.getData().toString('utf16le');
            if (!str.trim().startsWith('{')) str = layoutEntry.getData().toString('utf8');
            const layout = JSON.parse(str);

            if (layout.sections && Array.isArray(layout.sections)) {
                sections = layout.sections.map(s => {
                    const visualTypes = [];
                    if (s.visualContainers && Array.isArray(s.visualContainers)) {
                        s.visualContainers.forEach(vc => {
                            if (vc.config) {
                                try {
                                    const c = JSON.parse(vc.config);
                                    if (c.singleVisual && c.singleVisual.visualType) {
                                        visualTypes.push(c.singleVisual.visualType);
                                    }
                                } catch (err) {}
                            }
                        });
                    }
                    return {
                        displayName: s.displayName,
                        name: s.name,
                        visualsCount: s.visualContainers ? s.visualContainers.length : 0,
                        visualTypes: Array.from(new Set(visualTypes))
                    };
                });
            }

            // Mapeia colunas e propriedades
            function walk(o, currentTable) {
                if (!o || typeof o !== 'object') return;
                let tbl = currentTable;
                if (typeof o.Entity === 'string') { tbl = o.Entity; tables.add(tbl); }
                if (typeof o.Table === 'string') { tbl = o.Table; tables.add(tbl); }
                if (typeof o.Property === 'string' && o.Property.length > 0) {
                    columns.add({
                        name: o.Property,
                        table: tbl || (tables.size > 0 ? Array.from(tables)[0] : 'BASE BI')
                    });
                }
                for (let k of Object.keys(o)) {
                    if (typeof o[k] === 'string' && (o[k].startsWith('{') || o[k].startsWith('['))) {
                        try { walk(JSON.parse(o[k]), tbl); } catch (e) {}
                    } else {
                        walk(o[k], tbl);
                    }
                }
            }
            walk(layout, null);
        } catch (e) {}
    }

    // Agrupar colunas únicas por tabela
    const columnMap = new Map();
    columns.forEach(col => {
        const key = col.table + '.' + col.name;
        if (!columnMap.has(key)) {
            columnMap.set(key, col);
        }
    });

    const formattedColumns = Array.from(columnMap.values());
    const tableData = getBaseBiData();

    // Identifica todos os cabeçalhos das colunas encontradas na tabela principal
    const primaryTable = tables.size > 0 ? Array.from(tables)[0] : 'BASE BI';
    const primaryHeaders = formattedColumns
        .filter(c => c.table === primaryTable)
        .map(c => c.name);

    return {
        exists: true,
        fileName: path.basename(pbixFilePath),
        filePath: pbixFilePath,
        fileSize: stats.size,
        fileSizeFormatted: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
        lastModified: stats.mtime,
        metadata: metadata,
        tables: Array.from(tables),
        primaryTable: primaryTable,
        primaryHeaders: primaryHeaders,
        columnsCount: formattedColumns.length,
        columns: formattedColumns,
        sectionsCount: sections.length,
        sections: sections,
        tableData: tableData
    };
}

/**
 * Obtém a lista consolidada e tratada de pessoas / egressos disponíveis
 * @returns {Array<Object>} Lista de egressos com nome, url, headline, pdf e data
 */
function getEgressosPeople() {
    return getBaseBiData().map(r => ({
        nome: r['Nomes'],
        url: r.url,
        headline: r['Cargo'] + (r['Empresa'] ? (' na ' + r['Empresa']) : ''),
        cargo: r['Cargo'],
        empresa: r['Empresa'],
        area: r['Área'],
        cidade: r['Região (Cidade)'],
        dataScraping: r['Coleta de Dados'],
        pdfFile: r.pdfFile,
        numPaginas: r.numPaginas
    }));
}

/**
 * Exporta todos os perfis do LinkedIn para um arquivo CSV formatado para importação direta no Power BI
 * @param {string} [outputPath] 
 * @returns {string} Caminho do CSV gerado
 */
function exportProfilesToCsv(outputPath) {
    const csvPath = outputPath || path.join(__dirname, 'perfis_linkedin.csv');
    const records = getBaseBiData();
    
    const headers = ['Nomes', 'Cargo', 'Empresa', 'Área', 'Região (Cidade)', 'Coleta de Dados', 'STATUS', 'url', 'arquivo_pdf'];
    const rows = [headers.join(';')];
    
    for (const r of records) {
        const nome = `"${(r['Nomes'] || '').replace(/"/g, '""')}"`;
        const cargo = `"${(r['Cargo'] || '').replace(/"/g, '""')}"`;
        const empresa = `"${(r['Empresa'] || '').replace(/"/g, '""')}"`;
        const area = `"${(r['Área'] || '').replace(/"/g, '""')}"`;
        const cidade = `"${(r['Região (Cidade)'] || '').replace(/"/g, '""')}"`;
        const data = `"${(r['Coleta de Dados'] || '').replace(/"/g, '""')}"`;
        const status = `"${(r['STATUS'] || '').replace(/"/g, '""')}"`;
        const url = `"${(r.url || '').replace(/"/g, '""')}"`;
        const pdf = `"${(r.pdfFile || '').replace(/"/g, '""')}"`;
        
        rows.push([nome, cargo, empresa, area, cidade, data, status, url, pdf].join(';'));
    }
    
    const csvContent = '\uFEFF' + rows.join('\n');
    fs.writeFileSync(csvPath, csvContent, 'utf-8');
    console.log(`CSV exportado para Power BI com sucesso: ${csvPath}`);
    return csvPath;
}

module.exports = {
    inspectPbix,
    getReportLayout,
    savePbixLayout,
    getBaseBiData,
    getSemanticModel,
    getEgressosPeople,
    exportProfilesToCsv
};
