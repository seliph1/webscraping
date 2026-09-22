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
const { JSON_DIR } = require('./paths');

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

// Cache do índice de cargos regulamentados em memória (local_api/lista_cargos.json)
let _cargoIndex = null;

const termAliases = {
    'estagiaria': 'estagio',
    'estagiario': 'estagio',
    'developer': 'programador',
    'desenvolvedor': 'programador',
    'desenvolvedora': 'programador',
    'buyer': 'comprador',
    'consultant': 'consultor',
    'consultora': 'consultor',
    'coordenadora': 'coordenador',
    'administradora': 'administrador',
    'engenheira': 'engenheiro',
    'diretora': 'diretor',
    'supervisora': 'supervisor',
    'tecnica': 'tecnico',
    'operadora': 'operador',
    'gestora': 'gerente',
    'gestor': 'gerente',
    'associate': 'assistente',
    'leader': 'lider',
    'lider': 'coordenador'
};

function normalizeCargoString(str) {
    if (!str || typeof str !== 'string') return '';
    let s = str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove acentuação
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    const words = s.split(' ').map(w => termAliases[w] || w);
    return words.join(' ');
}

function getCargoIndex() {
    if (_cargoIndex) return _cargoIndex;
    _cargoIndex = [];

    const possiblePaths = [
        path.join(__dirname, 'local_api', 'lista_cargos.json'),
        path.join(__dirname, 'lista_cargos.json')
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            try {
                const list = JSON.parse(fs.readFileSync(p, 'utf8'));
                _cargoIndex = list.map(original => {
                    const norm = normalizeCargoString(original);
                    const tokens = norm.split(' ').filter(w => w.length > 2 && !['de', 'da', 'do', 'em', 'para', 'com', 'sem', 'dos', 'das'].includes(w));
                    return { original, norm, tokens };
                });
                break;
            } catch (e) {
                console.error('Aviso: Erro ao ler lista_cargos.json:', e.message);
            }
        }
    }
    return _cargoIndex;
}

/**
 * Valida se um determinado bloco de texto se aproxima de algum cargo regulamentado
 * constante na lista oficial (local_api/lista_cargos.json) em case-insensitive.
 * 
 * @param {string} candidate - Texto candidato extraído do PDF
 * @returns {{ isCargo: boolean, closestMatch: string, score: number, method: string }}
 */
function matchCargoWithList(candidate) {
    if (!candidate || typeof candidate !== 'string') return { isCargo: false, closestMatch: '', score: 0, method: '' };
    const cand = candidate.trim();
    if (cand.length < 3 || cand.length > 90) return { isCargo: false, closestMatch: '', score: 0, method: '' };
    
    // Filtros negativos (bullet points, durações temporais, vigência de datas, etc.)
    if (/^[\*\-•]/.test(cand)) return { isCargo: false, closestMatch: '', score: 0, method: '' };
    if (/^\d+\s*(?:ano|anos|mês|meses)/i.test(cand)) return { isCargo: false, closestMatch: '', score: 0, method: '' };
    if (dateRegex.test(cand)) return { isCargo: false, closestMatch: '', score: 0, method: '' };

    const cNorm = normalizeCargoString(cand);
    const cTokens = cNorm.split(' ').filter(w => w.length > 2 && !['de', 'da', 'do', 'em', 'para', 'com', 'sem', 'dos', 'das'].includes(w));
    if (cTokens.length === 0) return { isCargo: false, closestMatch: '', score: 0, method: '' };

    const index = getCargoIndex();

    // 1. Match exato ou substring direta
    for (const item of index) {
        if (item.norm === cNorm) {
            return { isCargo: true, closestMatch: item.original, score: 1.0, method: 'exact' };
        }
        if (cNorm.includes(item.norm) && item.norm.length >= 6) {
            return { isCargo: true, closestMatch: item.original, score: 0.9, method: 'substring_in_candidate' };
        }
        if (item.norm.includes(cNorm) && cNorm.length >= 6) {
            return { isCargo: true, closestMatch: item.original, score: 0.85, method: 'candidate_in_official' };
        }
    }

    // 2. Similaridade de tokens (Dice/Jaccard ponderado)
    let bestMatch = null;
    let bestScore = 0;

    for (const item of index) {
        let matches = 0;
        for (const token of cTokens) {
            if (item.tokens.some(it => it === token || it.startsWith(token) || token.startsWith(it))) {
                matches++;
            }
        }
        if (matches > 0) {
            const mainWordMatch = item.tokens[0] && (cTokens.includes(item.tokens[0]) || item.tokens[0] === cTokens[0]);
            const score = (2 * matches) / (cTokens.length + item.tokens.length) + (mainWordMatch ? 0.3 : 0);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = item;
            }
        }
    }

    if (bestMatch && bestScore >= 0.45) {
        return { isCargo: true, closestMatch: bestMatch.original, score: Math.min(1.0, bestScore), method: 'token_similarity' };
    }

    return { isCargo: false, closestMatch: '', score: 0, method: '' };
}

const lowerWordsSet = new Set([
    'de', 'da', 'do', 'das', 'dos',
    'em', 'na', 'no', 'nas', 'nos',
    'e', 'and', 'of', 'for',
    'a', 'o', 'as', 'os', 'ao', 'aos', 'à', 'às',
    'com', 'sem', 'por', 'para', 'pelo', 'pela', 'pelos', 'pelas', 'pro', 'pra', 'sob', 'sobre'
]);

const uppercaseAcronymsMap = {
    'ti': 'TI', 'rh': 'RH', 'sql': 'SQL', 'php': 'PHP', 'erp': 'ERP', 'crm': 'CRM',
    'seo': 'SEO', 'sac': 'SAC', 'uti': 'UTI', 'tv': 'TV', 'clp': 'CLP', 'cme': 'CME',
    'cnc': 'CNC', 'ctrc': 'CTRC', 'cftv': 'CFTV', 'ccih': 'CCIH', 'scih': 'SCIH',
    'pmo': 'PMO', 'pcp': 'PCP', 'pcm': 'PCM', 'qsms': 'QSMS', 'dba': 'DBA', 'dbm': 'DBM',
    'mis': 'MIS', 'soa': 'SOA', 'etl': 'ETL', 'bpm': 'BPM', 'abap': 'ABAP', 'asp': 'ASP',
    'c#': 'C#', 'c++': 'C++', 'vb6': 'VB6', '3d': '3D', 'dj': 'DJ', 'pl': 'PL',
    'rpg': 'RPG', 'ceo': 'CEO', 'bi': 'BI', 'sap': 'SAP', 'cad': 'CAD', 'cam': 'CAM',
    'ios': 'iOS', '.net': '.NET', 'ii': 'II', 'iii': 'III', 'iv': 'IV', 'vi': 'VI',
    'jr': 'Jr', 'sr': 'Sr'
};

function formatSingleCargoWord(w, isFirst) {
    const lower = w.toLowerCase();
    if (uppercaseAcronymsMap[lower]) return uppercaseAcronymsMap[lower];
    if (!isFirst && lowerWordsSet.has(lower)) return lower;
    if (w.includes('/')) {
        return w.split('/').map((part, pIdx) => formatSingleCargoWord(part, pIdx === 0 && isFirst)).join('/');
    }
    if (w.includes('-')) {
        return w.split('-').map((part, pIdx) => formatSingleCargoWord(part, pIdx === 0 && isFirst)).join('-');
    }
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/**
 * Converte o cargo para Title Case no padrão pt-BR preservando preposições e siglas.
 * 
 * @param {string} title - Título a formatar
 * @returns {string}
 */
function formatCargoTitleCase(title) {
    if (!title || typeof title !== 'string') return '';
    const words = title.trim().split(/\s+/);
    return words.map((w, idx) => formatSingleCargoWord(w, idx === 0)).join(' ');
}

/**
 * Parser semântico ancorado por datas para a seção "Experiência".
 * Localiza a vigência temporal e valida os blocos adjacentes contra
 * a lista de cargos regulamentados para evitar erros de deslocamento de texto.
 * 
 * @param {Array<string>} blocks - Lista de blocos de texto do PDF
 * @returns {{ empresa: string, cargo: string, match: Object|null }}
 */
function parseExperienceDetails(blocks) {
    const cleanBlocks = (blocks || []).filter(b => !/^Page\s+\d+\s+of\s+\d+/i.test(b.trim()));
    const expIdx = cleanBlocks.findIndex(b => b.trim() === 'Experiência');
    if (expIdx === -1) return { empresa: '', cargo: '', match: null };

    // Percorre até 15 linhas após "Experiência" em busca da linha com datas
    for (let i = expIdx + 1; i < Math.min(expIdx + 15, cleanBlocks.length); i++) {
        if (dateRegex.test(cleanBlocks[i])) {
            let cargo = '';
            let cargoMatch = null;
            let cargoIdx = -1;

            // Avalia os blocos imediatamente anteriores à data usando validação de cargo
            for (let k = i - 1; k > expIdx; k--) {
                const line = cleanBlocks[k].trim();
                // Ignora durações acumuladas e localizações
                if (/^\d+\s*(?:ano|anos|mês|meses)/i.test(line)) continue;
                if (isGeographicLocation(line)) continue;

                const m = matchCargoWithList(line);
                if (m.isCargo) {
                    cargo = line;
                    cargoMatch = m;
                    cargoIdx = k;
                    break;
                }
            }

            // Fallback caso nenhum bloco anterior tenha validado com alta pontuação
            if (!cargo && i > expIdx + 1) {
                // Seleciona a linha anterior filtrando durações e localizações
                for (let k = i - 1; k > expIdx; k--) {
                    const l = cleanBlocks[k].trim();
                    if (/^\d+\s*(?:ano|anos|mês|meses)/i.test(l) || isGeographicLocation(l)) continue;
                    cargo = l;
                    cargoIdx = k;
                    cargoMatch = matchCargoWithList(cargo);
                    break;
                }
            }

            // As linhas anteriores ao cargo (excluindo durações e localizações) compõem a empresa
            const companyLines = [];
            const endCompanyIdx = cargoIdx !== -1 ? cargoIdx : i - 1;
            for (let j = expIdx + 1; j < endCompanyIdx; j++) {
                const l = cleanBlocks[j].trim();
                if (/^\d+\s*(?:ano|anos|mês|meses)/i.test(l)) continue;
                if (isGeographicLocation(l)) continue;
                companyLines.push(l);
            }
            const empresa = companyLines.join(' ') || '';
            return { empresa, cargo, match: cargoMatch };
        }
    }
    return { empresa: cleanBlocks[expIdx + 1] || '', cargo: cleanBlocks[expIdx + 2] || '', match: null };
}

// Cache do índice geográfico carregado de local_api/bairros_brasil.json
let _geoIndex = null;

function getGeoIndex() {
    if (_geoIndex) return _geoIndex;
    _geoIndex = {
        ufs: new Set(),
        municipios: new Set(),
        bairros: new Set()
    };

    const geoFilePath = path.join(__dirname, 'local_api', 'bairros_brasil.json');
    if (fs.existsSync(geoFilePath)) {
        try {
            const geoData = JSON.parse(fs.readFileSync(geoFilePath, 'utf8'));
            geoData.forEach(u => {
                if (u.sigla_uf) _geoIndex.ufs.add(u.sigla_uf.toLowerCase());
                if (u.nome_uf) _geoIndex.ufs.add(u.nome_uf.toLowerCase());
                if (u.municipios && Array.isArray(u.municipios)) {
                    u.municipios.forEach(m => {
                        if (m.nome_municipio) _geoIndex.municipios.add(m.nome_municipio.toLowerCase());
                        if (m.bairros && Array.isArray(m.bairros)) {
                            m.bairros.forEach(b => {
                                if (b.nome_bairro) _geoIndex.bairros.add(b.nome_bairro.toLowerCase());
                            });
                        }
                    });
                }
            });
        } catch (e) {
            console.error('Aviso: Não foi possível indexar local_api/bairros_brasil.json:', e.message);
        }
    }
    return _geoIndex;
}

/**
 * Valida se uma determinada linha de texto representa uma localização geográfica real,
 * utilizando a base de municípios, UFs e bairros do Brasil e termos geográficos.
 * 
 * @param {string} line - Linha de texto a ser analisada
 * @returns {boolean}
 */
function isGeographicLocation(line) {
    if (!line || typeof line !== 'string') return false;
    const l = line.trim();
    if (l.length < 3 || l.length > 90) return false;
    // Não pode conter pipes '|' ou bullet points '•' (característicos de cargo/headline)
    if (l.includes('|') || l.includes('•')) return false;
    // Não pode ser cabeçalho de seção conhecido
    if (/^(resumo|experiência|contato|formação|page\s+\d+|certifications|languages|publications|principais\s+competências)/i.test(l)) return false;

    const lower = l.toLowerCase();

    // Se for exatamente o país ou denominação de região metropolitana isolada
    /*
    if (lower === 'brasil' || lower === 'brazil' || lower === 'portugal' || lower.endsWith('e região') || lower.endsWith('e regiao')) {
        return true;
    }*/

    const geo = getGeoIndex();

    // Se contiver vírgula (padrão de localização do LinkedIn: "Cidade, Estado, País")
    if (lower.includes(',')) {
        const parts = lower.split(',').map(p => p.trim()).filter(p => p.length > 0);
        if (parts.some(p => geo.municipios.has(p) || geo.ufs.has(p) || geo.bairros.has(p))) {
            return true;
        }
    }

    // Se for exatamente um município ou estado cadastrado
    if (geo.municipios.has(lower) || geo.ufs.has(lower)) {
        return true;
    }

    return false;
}

/**
 * Extrai com precisão a localização geográfica e a headline,
 * evitando erros de deslocamento causados por headlines multilinha.
 * 
 * @param {Array<string>} blocks - Blocos de texto do PDF
 * @param {string} personName - Nome do perfil
 * @returns {{ location: string, headline: string }}
 */
function extractLocationAndHeadline(blocks, personName) {
    const cleanBlocks = (blocks || []).filter(b => !/^Page\s+\d+\s+of\s+\d+/i.test(b.trim()));
    const pName = (personName || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Localiza o índice do nome do titular
    let nameIdx = -1;
    for (let i = 0; i < cleanBlocks.length; i++) {
        const bClean = cleanBlocks[i].toLowerCase().replace(/[^a-z0-9]/g, '');
        if (bClean.length > 3 && (bClean === pName || bClean.startsWith(pName) || pName.startsWith(bClean))) {
            nameIdx = i;
            break;
        }
    }

    let location = '';
    let headlineParts = [];

    if (nameIdx !== -1) {
        for (let i = nameIdx + 1; i < Math.min(nameIdx + 8, cleanBlocks.length); i++) {
            const b = cleanBlocks[i];
            if (b === 'Resumo' || b === 'Experiência') {
                // A linha imediatamente antes do Resumo/Experiência costuma ser a localização
                const prev = cleanBlocks[i - 1];
                if (isGeographicLocation(prev)) {
                    location = prev;
                }
                break;
            }
            if (isGeographicLocation(b)) {
                location = b;
                break;
            } else if (!b.startsWith('http') && b !== '--') {
                headlineParts.push(b);
            }
        }
    }

    // Se a localização não foi identificada no intervalo inicial, busca nos primeiros 35 blocos
    if (!location) {
        for (let i = 0; i < Math.min(cleanBlocks.length, 35); i++) {
            if (isGeographicLocation(cleanBlocks[i])) {
                location = cleanBlocks[i];
                break;
            }
        }
    }

    return {
        location: location || 'Não informado',
        headline: headlineParts.join(' | ')
    };
}

// Cache da lista de áreas econômicas carregadas de local_api/areas.json
let _areasList = null;

function getAreasList() {
    if (_areasList) return _areasList;
    _areasList = [];
    const areasPath = path.join(__dirname, 'local_api', 'areas.json');
    if (fs.existsSync(areasPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(areasPath, 'utf8'));
            _areasList = data.areas || [];
        } catch (e) {
            console.error('Aviso: Erro ao carregar local_api/areas.json:', e.message);
        }
    }
    return _areasList;
}


// TODO: desconsiderar tratamento de dados
const areaDefinitions = [
    {
        area: 'Tecnologia da Informação',
        regex: /\b(ti|software|developer|desenvolvedor|desenvolvedora|devops|infraestrutura|dados|data|sql|python|java|full stack|front-end|back-end|banco de dados|sistemas|computacao|computação|cloud|docker|programador|programadora|redes|web|helpdesk|suporte tecnico)\b/i
    },
    {
        area: 'Finanças',
        regex: /\b(financeiro|financeira|financas|finanças|fp&a|contas a pagar|contas a receber|tesouraria|investimentos|valuation|controladoria|custos|orcamento|orçamento|credito|cobranca|cobrança|risco|planejamento financeiro|financial|bancario)\b/i
    },
    {
        area: 'Contabilidade',
        regex: /\b(contabil|contábil|contador|contadora|contabilidade|fiscal|tributario|tributário)\b/i
    },
    {
        area: 'Recursos Humanos',
        regex: /\b(rh|recursos humanos|recrutamento|selecao|seleção|r&s|dho|dp|departamento pessoal|atracao de talentos|atração de talentos|remuneracao|remuneração|beneficios|benefícios|gente e gestao|gente e gestão|treinamento|folha de pagamento)\b/i
    },
    {
        area: 'Compras e Suprimentos',
        regex: /\b(compras|comprador|compradora|suprimentos|procurement|buyer|sourcing|cotacao|cotação|almoxarifado|estoque)\b/i
    },
    {
        area: 'Marketing',
        regex: /\b(marketing|publicidade|propaganda|crm|branding|social media|midia social|mídia social|conteudo|conteúdo|growth|marketplace|digital marketing|loyalty|affiliate|merchandising)\b/i
    },
    {
        area: 'Qualidade',
        regex: /\b(qualidade|processos|melhoria continua|melhoria contínua|iso|sgq|garantia da qualidade|auditoria da qualidade)\b/i
    },
    {
        area: 'Consultoria',
        regex: /\b(consultor|consultora|consultoria|consultant|advisory)\b/i
    },
    {
        area: 'Comercial',
        regex: /\b(comercial|key account|inside sales|relacionamento|parcerias)\b/i
    },
    {
        area: 'Vendas',
        regex: /\b(vendas|vendedor|vendedora|executivo de vendas|representante comercial|balconista)\b/i
    },
    {
        area: 'Educação',
        regex: /\b(professor|professora|docente|pedagogo|pedagoga|monitor|monitora|ensino|instrutor|estatistica aplicada|estatística aplicada|educacional)\b/i
    },
    {
        area: 'Engenharia',
        regex: /\b(engenharia|engenheiro|engenheira)\b/i
    },
    {
        area: 'Logística e Transportes',
        regex: /\b(logistica|logística|transporte|transportes|frotas|expedicao|expedição|armazem|armazém|distribuicao|distribuição|supply chain|motorista)\b/i
    },
    {
        area: 'Jurídico',
        regex: /\b(advogado|advogada|juridico|jurídico|direito|paralegal)\b/i
    },
    {
        area: 'Auditoria',
        regex: /\b(auditor|auditora|auditoria|compliance|controles internos)\b/i
    },
    {
        area: 'Artes e Cultura',
        regex: /\b(teatro|arte|artes|cinema|espetaculo|espetáculo|musica|música|cultura|producao cultural)\b/i
    },
    {
        area: 'Saúde',
        regex: /\b(saude|saúde|medico|médico|medica|médica|enfermeiro|enfermeira|farmaceutico|farmacêutico|nutricionista|hospitalar|clinico|psicologo|psicólogo|fisioterapeuta)\b/i
    },
    {
        area: 'Atendimento ao Cliente',
        regex: /\b(atendimento|sac|call center|telemarketing|customer success|recepcao|recepcionista)\b/i
    },
    {
        area: 'Design',
        regex: /\b(designer|design|ui\/ux|web design|ilustrador|ilustradora)\b/i
    },
    {
        area: 'Administrativo',
        regex: /\b(administrativo|administrativa|auxiliar de escritorio|auxiliar de escritório|secretaria|secretária)\b/i
    },
    {
        area: 'Gestão e Administração',
        regex: /\b(administracao|administração|administrador|administradora|gerente|gerencia|gerência|coordenador|coordenadora|supervisor|supervisora|diretor|diretora|projetos|project manager|pmo|operacoes|operações|empreendedor|ceo|gestor|gestora)\b/i
    }
];

/**
 * Determina e valida a Área de Atuação Econômica conforme local_api/areas.json.
 * Analisa prioritariamente o cargo funcional, a empresa e a headline profissional.
 * 
 * @param {string} cargo - Cargo do profissional
 * @param {string} headline - Headline ou resumo no topo do perfil
 * @param {string} empresa - Nome da empresa
 * @returns {string} Área econômica oficial de areas.json
 */
function determineEconomicArea(cargo, headline, empresa) {
    const validAreas = getAreasList();
    const c = cargo || '';
    const h = headline || '';
    const e = empresa || '';

    // 1. Testa primeiramente no cargo (prioridade funcional máxima)
    for (const def of areaDefinitions) {
        if (def.regex.test(c)) {
            if (validAreas.includes(def.area)) return def.area;
        }
    }

    // 2. Se o cargo for genérico (ex: "Estagiário"), verifica a empresa (ex: Teatro Rival -> Artes e Cultura)
    if (e) {
        for (const def of areaDefinitions) {
            if (def.regex.test(e)) {
                if (validAreas.includes(def.area)) return def.area;
            }
        }
    }

    // 3. Testa na headline profissional
    for (const def of areaDefinitions) {
        if (def.regex.test(h)) {
            if (validAreas.includes(def.area)) return def.area;
        }
    }

    // 4. Fallback padrão garantido em areas.json
    return validAreas.includes('Gestão e Administração') ? 'Gestão e Administração' : (validAreas[0] || 'Não informado');
}

/**
 * Lê todos os arquivos JSON da pasta 'dados_json' e monta os registros estruturados
 * para a aba "Registro de Dados" (dados coletados via scraping).
 * 
 * @returns {Array<Object>} Lista de registros consolidados
 */
function getBaseBiData() {
    const jsonFolder = JSON_DIR;
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

            // Prevenção de duplicatas (por URL ou nome)
            const key = (url || name).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            // Extração de Empresa e Cargo via parser inteligente
            const expParsed = parseExperienceDetails(blocks);
            let empresa = expParsed.empresa;
            let cargo = expParsed.cargo;

            // Extração semântica protegida de Região (Cidade) e Headline
            const geoExtracted = extractLocationAndHeadline(blocks, name);
            const location = geoExtracted.location;
            const headline = geoExtracted.headline;

            // Fallback para cargo a partir da headline validada contra a lista de cargos
            if (!cargo && headline) {
                const parts = headline.split('|').map(p => p.trim()).filter(p => p.length > 0);
                let bestPart = '';
                let bestScore = 0;
                for (const part of parts) {
                    const m = matchCargoWithList(part);
                    if (m.isCargo && m.score > bestScore) {
                        bestScore = m.score;
                        bestPart = part;
                    }
                }
                cargo = bestPart || parts[0] || '';
            }

            // Formata o cargo em Title Case padronizado
            if (cargo) {
                cargo = formatCargoTitleCase(cargo);
            }

            if (!empresa && headline) {
                const matchNa = headline.match(/(?:na|no|at|em)\s+([A-Za-z0-9\s&.-]+)/i);
                if (matchNa) empresa = matchNa[1].split('|')[0].trim();
            }

            // Categorização contextual de área de atuação profissional
            // Classificação e validação da Área de Atuação Econômica conforme local_api/areas.json
            const area = determineEconomicArea(cargo, headline, empresa);


            // Critério para pessoas que trabalham em multiplas empresas 
            // Ou cargos diferentes dentro da mesma empresa
            // Linhas duplicadas para acumulos de cargo

            // Histórico dos cargos (caso apareça mais de um cargo no card de empresa)
            


            records.push({
                'Nomes': name || 'Não informado',
                'Cargo': cargo || headline || 'Não informado',
                'Empresa': empresa || 'Não informado',
                'Área': area,
                'Região (Cidade)': location || 'Não informado',
                'Coleta de Dados': data.dataScraping || data.data_scraping || '-',
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
