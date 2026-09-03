/**
 * ============================================================================
 * MÓDULO DE MANIPULAÇÃO DE ARQUIVOS POWER BI (.PBIX) E MODELO SEMÂNTICO
 * ============================================================================
 * Responsabilidades:
 *  1. Extração da tabela interna real do Power BI via VertiPaq e XPress9 (WASM).
 *  2. Leitura e agregação dos dados coletados dos perfis raspados (dados_json/).
 *  3. Parser semântico com ancoragem por datas para resolução de cargos e empresas.
 *  4. Reconstituição resiliente de URLs do LinkedIn divididas por quebra de linha.
 *  5. Inspeção do arquivo .pbix (ZIP, DiagramLayout, Metadata, Report/Layout).
 *  6. Exportação para CSV compatível com Excel e Power BI (com UTF-8 BOM).
 * ============================================================================
 */

const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const decoder = require('./pbixDecoder');

// Cache em memória para os dados da tabela real do PBIX (evita re-decodificar a cada requisição)
let _pbixRealCache = null;
let _pbixLastMtime = null;
let _pbixLastPath = null;

/**
 * Extrai a tabela real contida diretamente dentro do arquivo .pbix.
 * O fluxo de decodificação compreende:
 *  - Abrir o .pbix como arquivo compactado ZIP.
 *  - Extrair o stream binário 'DataModel'.
 *  - Descompactar o stream usando o descompressor Microsoft XPress9 (WebAssembly).
 *  - Analisar o contêiner ABF (Analysis Services Backup Format).
 *  - Ler os metadados relacionais do banco embutido 'metadata.sqlitedb'.
 *  - Mapear os arquivos de dicionário (.dictionary) e índices (.idf) de cada coluna.
 *  - Recompor todas as linhas da tabela principal (ex: 'BASE BI').
 * 
 * @param {string} pbixFilePath - Caminho completo do arquivo .pbix no disco
 * @returns {Promise<Object>} { success, tableName, columns, rowCount, rows }
 */
async function getPbixRealTable(pbixFilePath) {
    // Validação de existência do arquivo físico
    if (!fs.existsSync(pbixFilePath)) {
        return {
            success: false,
            error: 'Arquivo .pbix não encontrado.',
            tableName: 'BASE BI',
            columns: [],
            rowCount: 0,
            rows: []
        };
    }

    // Mecanismo de cache baseado na data de modificação (mtime) do arquivo .pbix
    const stats = fs.statSync(pbixFilePath);
    if (_pbixRealCache && _pbixLastPath === pbixFilePath && _pbixLastMtime === stats.mtimeMs) {
        return _pbixRealCache;
    }

    try {
        // 1. Abertura do ZIP e localização do DataModel
        const zip = new AdmZip(pbixFilePath);
        const dmEntry = zip.getEntry('DataModel');
        if (!dmEntry) {
            throw new Error('DataModel não encontrado dentro do arquivo .pbix.');
        }

        // 2. Descompressão do XPress9 em memória via WASM
        const dmBuf = dmEntry.getData();
        const decompressed = await decoder.decompressXpress9(dmBuf);

        // 3. Leitura das estruturas internas do Analysis Services (ABF)
        const abf = decoder.parseABF(decompressed);
        const sqliteBuf = decoder.getDataSlice(abf, 'metadata.sqlitedb');
        const db = decoder.readSQLiteTables(sqliteBuf);
        const schema = decoder.buildSchemaFromSQLite(db);
        const fileCache = decoder._buildFileCache(schema, abf);

        // 4. Identificação da tabela principal de negócio (ignorando tabelas de data geradas automaticamente)
        const tableNames = Array.from(schema.keys()).filter(t => !t.startsWith('LocalDateTable_') && !t.startsWith('DateTableTemplate_'));
        const tableName = tableNames.includes('BASE BI') ? 'BASE BI' : (tableNames[0] || 'BASE BI');
        const tSchema = schema.get(tableName);

        if (!tSchema) {
            throw new Error('Esquema da tabela ' + tableName + ' não encontrado no modelo.');
        }

        // 5. Decodificação das colunas e valores VertiPaq
        const columns = [];
        const colData = {};

        for (const col of tSchema.columns) {
            const vals = decoder._extractColumn(col, fileCache);
            if (vals !== null) {
                columns.push(col.name);
                colData[col.name] = vals;
            }
        }

        const rowCount = colData[columns[0]] ? colData[columns[0]].length : 0;
        const rows = [];

        // 6. Montagem do array de objetos com todas as linhas e colunas
        for (let i = 0; i < rowCount; i++) {
            const row = {};
            for (const colName of columns) {
                row[colName] = colData[colName][i];
            }
            rows.push(row);
        }

        // Atualização do cache em memória
        _pbixRealCache = {
            success: true,
            tableName: tableName,
            columns: columns,
            rowCount: rowCount,
            rows: rows
        };
        _pbixLastMtime = stats.mtimeMs;
        _pbixLastPath = pbixFilePath;

        return _pbixRealCache;
    } catch (err) {
        console.error('Erro ao extrair tabela real do .pbix:', err);
        return {
            success: false,
            error: err.message,
            tableName: 'BASE BI',
            columns: [],
            rowCount: 0,
            rows: []
        };
    }
}

/**
 * Inspeciona o arquivo .pbix retornando a lista de caminhos de arquivos contidos no ZIP.
 * @param {string} pbixFilePath - Caminho do arquivo .pbix
 * @returns {Array<string>} Lista de nomes de entradas internas
 */
function inspectPbix(pbixFilePath) {
    if (!fs.existsSync(pbixFilePath)) {
        throw new Error(`Arquivo .pbix não encontrado: ${pbixFilePath}`);
    }
    const zip = new AdmZip(pbixFilePath);
    return zip.getEntries().map(entry => entry.entryName);
}

/**
 * Extrai e decodifica o arquivo de layout visual do Power BI ('Report/Layout').
 * O arquivo pode estar codificado em UTF-16LE ou UTF-8.
 * @param {string} pbixFilePath - Caminho do arquivo .pbix
 * @returns {Object} Objeto JSON com as seções e visuais do relatório
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
 * Salva um layout modificado de volta para o arquivo .pbix (codificado em UTF-16LE).
 * @param {string} sourcePbixPath - Caminho do .pbix de origem
 * @param {Object} newLayoutObj - Estrutura de layout modificada
 * @param {string} targetPbixPath - Caminho onde o novo .pbix será gravado
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
 * Resolve e reconstrói a URL completa do LinkedIn a partir dos dados do JSON ou do texto bruto.
 * Trata casos em que a coluna lateral estreita do PDF quebrou a URL com hífen em duas linhas:
 * Ex: "www.linkedin.com/in/alan-" + "moura-8ba712170 (LinkedIn)" -> "https://www.linkedin.com/in/alan-moura-8ba712170".
 * 
 * @param {string} dataUrl - URL pré-existente salva no JSON
 * @param {string} rawText - Texto bruto extraído do PDF
 * @param {Array<string>} blocks - Blocos de texto do PDF
 * @returns {string} URL limpa e normalizada
 */
function resolveProfileUrl(dataUrl, rawText, blocks) {
    // Se a URL já estiver completa e não terminar com hífen, mantém
    if (dataUrl && dataUrl.startsWith('http') && !dataUrl.endsWith('-') && !dataUrl.endsWith('/in/')) {
        return dataUrl.trim().replace(/\/+$/, '');
    }

    const text = rawText || (blocks || []).join('\n');
    // Regex para capturar a primeira parte após /in/ e uma possível continuação na linha seguinte
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
    return dataUrl || '';
}

// Regex para identificar linhas de período temporal no currículo do LinkedIn
const dateRegex = /(?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|\d{4}).*?(?:present|\d{4})/i;

/**
 * Parser semântico ancorado por datas para a seção "Experiência".
 * Em vez de assumir posições fixas de linhas, localiza a linha de vigência temporal:
 *  - A linha imediatamente ANTERIOR à data é o verdadeiro cargo (ex: 'Analista de Remuneração e Benefícios Júnior').
 *  - As linhas ANTERIORES ao cargo (filtrando durações acumuladas como '3 anos 4 meses') formam a empresa.
 * 
 * @param {Array<string>} blocks - Lista de blocos de texto do PDF
 * @returns {Object} { empresa, cargo }
 */
function parseExperienceDetails(blocks) {
    // Remove marcadores de paginação como "Page 1 of 2"
    const cleanBlocks = (blocks || []).filter(b => !/^Page\s+\d+\s+of\s+\d+/i.test(b.trim()));
    const expIdx = cleanBlocks.findIndex(b => b.trim() === 'Experiência');
    if (expIdx === -1) return { empresa: '', cargo: '' };

    // Percorre até 15 linhas após "Experiência" em busca da linha com datas
    for (let i = expIdx + 1; i < Math.min(expIdx + 15, cleanBlocks.length); i++) {
        if (dateRegex.test(cleanBlocks[i])) {
            const cargo = cleanBlocks[i - 1];
            const companyLines = [];
            for (let j = expIdx + 1; j < i - 1; j++) {
                const l = cleanBlocks[j].trim();
                // Ignora tempos de permanência cumulativa na empresa (ex: '3 anos 4 meses', '11 meses')
                if (/^\d+\s*(?:ano|anos|mês|meses)/i.test(l)) continue;
                companyLines.push(l);
            }
            const empresa = companyLines.join(' ') || '';
            return { empresa, cargo };
        }
    }
    return { empresa: cleanBlocks[expIdx + 1] || '', cargo: cleanBlocks[expIdx + 2] || '' };
}

/**
 * Lê todos os arquivos JSON da pasta 'dados_json' e monta os registros estruturados
 * para a aba "Registro de Dados" (dados coletados via scraping).
 * 
 * @returns {Array<Object>} Lista de registros consolidados
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
            if (name.toLowerCase().includes('teste')) continue;

            const blocks = data.rawBlocks || [];
            const url = resolveProfileUrl(data.url, data.rawText, blocks);

            // Reconstitui nome completo caso tenha vindo apenas o primeiro nome
            if (!name.includes(' ')) {
                const candidate = blocks.find(b => b.startsWith(name + ' ') && b.split(' ').length >= 2 && b.length < 50);
                if (candidate) name = candidate;
            }

            // Correção de acentuação comum de nomes portugueses
            name = name
                .replace(/^Letcia\b/, 'Letícia')
                .replace(/\bFrazo\b/, 'Frazão')
                .replace(/\bBencio\b/, 'Benício')
                .replace(/\bLivia\b/, 'Lívia');

            // Prevenção de duplicatas (por URL ou nome)
            const key = (url || name).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            // Extração de Empresa e Cargo via parser inteligente
            const expParsed = parseExperienceDetails(blocks);
            let empresa = expParsed.empresa;
            let cargo = expParsed.cargo;
            let headline = '';
            let location = '';

            // Headline sob o nome no topo do currículo
            const cleanBlocks = blocks.filter(b => !/^Page\s+\d+\s+of\s+\d+/i.test(b.trim()));
            const nameIdx = cleanBlocks.indexOf(name);
            if (nameIdx !== -1) {
                if (cleanBlocks[nameIdx + 1] && !cleanBlocks[nameIdx + 1].startsWith('http') && cleanBlocks[nameIdx + 1] !== '--') {
                    headline = cleanBlocks[nameIdx + 1];
                }
                if (cleanBlocks[nameIdx + 2] && !cleanBlocks[nameIdx + 2].includes('Experiência') && !cleanBlocks[nameIdx + 2].includes('Resumo')) {
                    location = cleanBlocks[nameIdx + 2];
                }
            }

            // Fallback para cargo e empresa a partir da headline
            if (!cargo && headline) {
                cargo = headline.split('|')[0].trim();
            }
            if (!empresa && headline) {
                const matchNa = headline.match(/(?:na|no|at|em)\s+([A-Za-z0-9\s&.-]+)/i);
                if (matchNa) empresa = matchNa[1].split('|')[0].trim();
            }

            // Categorização contextual de área de atuação profissional
            const hLower = (headline + ' ' + cargo + ' ' + (data.rawText || '')).toLowerCase();
            let area = 'Administração Geral';
            if (hLower.includes('dados') || hLower.includes('data') || hLower.includes('bi ') || hLower.includes('sql') || hLower.includes('analyst') || hLower.includes('buyer')) {
                area = 'Análise de Dados / BI';
            } else if (hLower.includes('finance') || hLower.includes('controladoria') || hLower.includes('investimento') || hLower.includes('risco') || hLower.includes('contas a pagar') || hLower.includes('contas a receber')) {
                area = 'Finanças & Controladoria';
            } else if (hLower.includes('rh') || hLower.includes('recursos humanos') || hLower.includes('remunera') || hLower.includes('benefício') || hLower.includes('recrutamento') || hLower.includes('r&s') || hLower.includes('atração de talentos')) {
                area = 'Recursos Humanos';
            } else if (hLower.includes('software') || hLower.includes('developer') || hLower.includes('devops') || hLower.includes('infraestrutura') || hLower.includes('docker') || hLower.includes('full stack')) {
                area = 'Tecnologia / TI';
            } else if (hLower.includes('marketing') || hLower.includes('venda') || hLower.includes('comercial')) {
                area = 'Comercial & Marketing';
            } else if (hLower.includes('administra') || hLower.includes('projetos') || hLower.includes('gest') || hLower.includes('consultant')) {
                area = 'Administração & Gestão';
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
        } catch (e) {
            console.error('Erro ao processar arquivo para BASE BI:', file, e);
        }
    }

    return records.sort((a, b) => a['Nomes'].localeCompare(b['Nomes'], 'pt-BR'));
}

/**
 * Extrai os metadados visuais e lógicos do modelo semântico do .pbix
 * (tabelas mapeadas, colunas, páginas do relatório e número de visuais).
 * 
 * @param {string} pbixFilePath - Caminho do arquivo .pbix
 * @returns {Object} Estrutura descritiva do modelo semântico
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

    // 1. Extração das tabelas através do DiagramLayout
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

    // 2. Extração dos metadados de versão
    const metaEntry = zip.getEntry('Metadata');
    if (metaEntry) {
        try {
            let str = metaEntry.getData().toString('utf16le');
            if (!str.trim().startsWith('{')) str = metaEntry.getData().toString('utf8');
            metadata = JSON.parse(str);
        } catch (e) {}
    }

    // 3. Extração das páginas e visuais do relatório em Report/Layout
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

            // Função recursiva para mapear entidades e propriedades referenciadas nos visuais
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

    const columnMap = new Map();
    columns.forEach(col => {
        const key = col.table + '.' + col.name;
        if (!columnMap.has(key)) {
            columnMap.set(key, col);
        }
    });

    const formattedColumns = Array.from(columnMap.values());
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
        sections: sections
    };
}

/**
 * Retorna a lista de pessoas para consumo simplificado em JSON.
 * @returns {Array<Object>} Lista de egressos formatada
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
 * Exporta a tabela real extraída do .pbix para um arquivo CSV estruturado.
 * Inclui o Byte Order Mark (BOM) UTF-8 (\uFEFF) para garantir abertura correta no Excel.
 * 
 * @param {string} pbixFilePath - Caminho do .pbix
 * @param {string} [outputPath] - Caminho opcional do arquivo CSV de saída
 * @returns {Promise<string>} Caminho do arquivo gerado
 */
async function exportPbixRealTableToCsv(pbixFilePath, outputPath) {
    const csvPath = outputPath || path.join(__dirname, 'tabela_pbix_exportada.csv');
    const tableData = await getPbixRealTable(pbixFilePath);
    
    if (!tableData.rows || tableData.rows.length === 0) {
        throw new Error('Nenhum dado encontrado para exportação no .pbix');
    }

    const headers = tableData.columns;
    const rows = [headers.map(h => `"${h}"`).join(';')];

    for (const r of tableData.rows) {
        const line = headers.map(h => {
            const val = r[h];
            if (val === null || val === undefined) return '""';
            return `"${String(val).replace(/"/g, '""')}"`;
        });
        rows.push(line.join(';'));
    }

    // UTF-8 BOM para garantir acentuação correta no Microsoft Excel
    const csvContent = '\uFEFF' + rows.join('\n');
    fs.writeFileSync(csvPath, csvContent, 'utf-8');
    return csvPath;
}

/**
 * Exporta todos os perfis coletados do LinkedIn para um arquivo CSV formatado para Power BI.
 * 
 * @param {string} [outputPath] - Caminho opcional de saída do arquivo CSV
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
    getPbixRealTable,
    exportPbixRealTableToCsv,
    exportProfilesToCsv
};
