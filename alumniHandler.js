/**
 * ============================================================================
 * GERENCIADOR DE ALUNOS & LINKS CONSOLIDADOS (alumniHandler.js)
 * ============================================================================
 * Responsabilidades:
 *  1. Leitura e mesclagem resiliente das planilhas:
 *     - "Alunos de ADM - 2026-08-28.xlsx" (Matrícula, Nome, Data de Nascimento)
 *     - "lista geral linkedin 2026-08-31.xlsx" (Nomes e Links do LinkedIn)
 *  2. Geração da lista única consolidada na ordem requerida:
 *     "Matrícula - Nome do Aluno - Data de nascimento - Linkedin"
 *  3. Mapeamento de status de coleta contra arquivos salvos em dados_json/.
 *  4. Extração fiel e não-inferida de todas as experiências profissionais
 *     (cargos, empresas, estágios, períodos de início e término verbatim).
 *  5. Exportação para arquivo CSV com cabeçalhos exatos:
 *     "Matrícula;Nome do Aluno;Data de nascimento;Linkedin;Experiência Profissional"
 *     com codificação UTF-8 BOM e compatibilidade total com Excel.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { EXTERNAL_BASE_DIR, JSON_DIR, PDFS_DIR } = require('./paths');

// Cache em memória dos alunos processados
let cachedStudentsList = null;
let lastCacheTimestamp = 0;

/**
 * Normaliza nomes para permitir casamento resiliente entre planilhas e perfis
 * (remove acentos, pontuação, múltiplos espaços e converte para maiúsculas).
 * 
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ');
}

/**
 * Normaliza o identificador (slug) único de uma URL do LinkedIn:
 * decodifica percent-encoding (ex: %C3%A7 -> ç),
 * remove acentos / diacríticos (ex: ç -> c, é -> e),
 * remove traços no final e converte para minúsculas.
 * 
 * @param {string} raw
 * @returns {string}
 */
function normalizeSlug(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let str = raw.trim();
    try {
        str = decodeURIComponent(str);
    } catch (e) {}
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\/+$/, '')
        .replace(/-+$/, '')
        .trim();
}

/**
 * Extrai o identificador (slug) único e normalizado de uma URL do LinkedIn.
 * Ex: https://www.linkedin.com/in/beatriz-gon%C3%A7alves-123 -> "beatriz-goncalves-123"
 */
function extractSlug(url) {
    if (!url || typeof url !== 'string') return '';
    let clean = url.trim().split('?')[0].split('#')[0].replace(/\/+$/, '');
    try {
        clean = decodeURIComponent(clean);
    } catch (e) {}
    const m = clean.match(/linkedin\.com\/in\/([^\/\?\#]+)/i);
    if (m) {
        return normalizeSlug(m[1]);
    }
    const parts = clean.split('/');
    return normalizeSlug(parts[parts.length - 1]);
}

/**
 * Normaliza e limpa URLs do LinkedIn removendo query params e parâmetros de rastreamento,
 * garantindo o formato com protocolo https:// e sem query strings.
 * 
 * @param {string} url
 * @returns {string}
 */
function cleanLinkedInUrl(url) {
    if (!url || typeof url !== 'string') return '';
    let cleaned = url.trim().split('?')[0].split('#')[0].replace(/\/+$/, '');

    if (cleaned.startsWith('http://')) {
        cleaned = 'https://' + cleaned.substring(7);
    } else if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
        cleaned = 'https://' + cleaned;
    }

    return cleaned;
}


/**
 * Decodifica entidades XML comuns.
 */
function decodeXmlEntities(text) {
    if (!text) return '';
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

/**
 * Extrai a tabela de strings compartilhadas (xl/sharedStrings.xml) de um arquivo .xlsx.
 */
function parseSharedStrings(zip) {
    if (!zip.getEntry('xl/sharedStrings.xml')) return [];
    try {
        const xml = zip.readAsText('xl/sharedStrings.xml');
        const strings = [];
        const siRegex = /<si\b[^>]*>(.*?)<\/si>/gs;
        let match;
        while ((match = siRegex.exec(xml)) !== null) {
            const siContent = match[1];
            const tMatches = siContent.match(/<t\b[^>]*>(.*?)<\/t>/gs);
            if (tMatches) {
                const text = tMatches.map(t => t.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, '')).join('');
                strings.push(decodeXmlEntities(text));
            } else {
                strings.push('');
            }
        }
        return strings;
    } catch (e) {
        console.error('Erro ao ler sharedStrings.xml:', e.message);
        return [];
    }
}

/**
 * Converte letras de coluna do Excel (A, B, AA, AB...) em índice base 0.
 */
function colLetterToIndex(col) {
    let index = 0;
    for (let i = 0; i < col.length; i++) {
        index = index * 26 + (col.charCodeAt(i) - 64);
    }
    return index - 1;
}

/**
 * Lê e decodifica as linhas de uma planilha específica (worksheet) de um .xlsx.
 */
function parseWorksheet(zip, sheetPath, sharedStrings) {
    if (!zip.getEntry(sheetPath)) return [];
    try {
        const xml = zip.readAsText(sheetPath);
        const rows = [];
        const rowRegex = /<row\b[^>]*\br="(\d+)"[^>]*>(.*?)<\/row>/gs;
        let rowMatch;

        while ((rowMatch = rowRegex.exec(xml)) !== null) {
            const rowContent = rowMatch[2];
            const rowData = [];

            const cellRegex = /<c\b[^>]*\br="([A-Z]+)\d+"([^>]*)>(.*?)<\/c>/gs;
            let cellMatch;
            while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
                const colLetters = cellMatch[1];
                const colIdx = colLetterToIndex(colLetters);
                const attrs = cellMatch[2];
                const body = cellMatch[3];

                const isString = /t="s"/.test(attrs);
                const isInline = /t="inlineStr"/.test(attrs);

                let val = '';
                if (isInline) {
                    const tMatch = body.match(/<t\b[^>]*>(.*?)<\/t>/s);
                    val = tMatch ? decodeXmlEntities(tMatch[1]) : '';
                } else {
                    const vMatch = body.match(/<v\b[^>]*>(.*?)<\/v>/s);
                    if (vMatch) {
                        const rawVal = vMatch[1].trim();
                        if (isString) {
                            const strIdx = parseInt(rawVal, 10);
                            val = sharedStrings[strIdx] !== undefined ? sharedStrings[strIdx] : '';
                        } else {
                            val = rawVal;
                        }
                    }
                }

                rowData[colIdx] = val;
            }

            for (let i = 0; i < rowData.length; i++) {
                if (rowData[i] === undefined) rowData[i] = '';
            }
            rows.push(rowData);
        }

        return rows;
    } catch (e) {
        console.error('Erro ao ler worksheet ' + sheetPath + ':', e.message);
        return [];
    }
}

/**
 * Localiza um arquivo no disco buscando primeiro no diretório externo e depois no __dirname,
 * suportando busca por padrão regex.
 * 
 * @param {RegExp} pattern
 * @param {string} fallbackName
 * @returns {string|null} Caminho absoluto ou null
 */
function findFileByPattern(pattern, fallbackName) {
    const candidatesDirs = [EXTERNAL_BASE_DIR, __dirname];
    for (const dir of candidatesDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                if (pattern.test(f)) {
                    return path.join(dir, f);
                }
            }
        } catch (e) {}
    }
    // Tenta fallback direto
    for (const dir of candidatesDirs) {
        const direct = path.join(dir, fallbackName);
        if (fs.existsSync(direct)) return direct;
    }
    return null;
}

/**
 * Extrai fielmente todas as experiências profissionais contidas no texto bruto
 * (cargos, empresas, datas de início e término, estágios, descrições verbatim),
 * sem inferência ou descarte de dados, suportando termos multilíngues.
 * 
 * @param {string} rawText - Texto bruto extraído do PDF ou página
 * @returns {string} Bloco com todas as experiências ou string vazia
 */
function extractExperienceFromText(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    // Limpa ruídos de paginação gerados pelo LinkedIn
    const cleaned = rawText.replace(/Page\s+\d+\s+of\s+\d+/gi, '').replace(/\r\n/g, '\n');

    // Captura a partir de "Experiência" ou cabeçalhos internacionais até o próximo cabeçalho principal
    const match = cleaned.match(/(?:^|\n)(?:Experiência|Experience|Expérience|Experiencia)\s*\n([\s\S]*?)(?=\n(?:Formação acadêmica|Formação|Formation|Educação|Education|Educación|Competências|Skills|Compétences|Competencias|Licenças e certificados|Licenses & certifications|Licences et certifications|Idiomas|Languages|Langues|Cursos|Courses|Recomendações|Recommendations|Projetos|Projects|Projets|Publicações|Publications|Prêmios|Honors & awards|Organizações|Organizations)|$)/i);

    if (match && match[1]) {
        return match[1].trim();
    }
    return '';
}

/**
 * Mescla registros de perfis duplicados ou re-raspados, garantindo que
 * o registro com maior detalhamento de experiência prevaleça sem perdas.
 */
function mergeScrapedRecords(existing, incoming) {
    if (!existing) return incoming;
    const existingExp = (existing.experienciaProfissional || '').trim();
    const incomingExp = (incoming.experienciaProfissional || '').trim();

    if (incomingExp.length > 0 && existingExp.length === 0) return incoming;
    if (existingExp.length > 0 && incomingExp.length === 0) return existing;

    // Se ambos têm experiência, prioriza o arquivo raspado mais recentemente
    if ((incoming.mtime || 0) >= (existing.mtime || 0)) return incoming;
    return existing;
}

/**
 * Mapeia todos os arquivos já raspados na pasta dados_json/ indexados por URL, slug e nome.
 */
function getScrapedProfilesIndex() {
    const byUrl = new Map();
    const bySlug = new Map();
    const byName = new Map();

    if (!fs.existsSync(JSON_DIR)) return { byUrl, bySlug, byName };

    try {
        // Ordena arquivos pelo tempo de modificação crescente para manter consistência
        const fileList = fs.readdirSync(JSON_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const fullPath = path.join(JSON_DIR, f);
                let mtime = 0;
                try { mtime = fs.statSync(fullPath).mtimeMs; } catch (e) {}
                return { file: f, fullPath, mtime };
            })
            .sort((a, b) => a.mtime - b.mtime);

        for (const item of fileList) {
            try {
                const data = JSON.parse(fs.readFileSync(item.fullPath, 'utf8'));

                // Extrai ou reutiliza experiência profissional sem omissão de detalhes
                let exp = data.experienciaProfissional;
                if ((!exp || exp.trim().length === 0) && data.rawText) {
                    exp = extractExperienceFromText(data.rawText);
                }

                let resolvedPdf = data.pdfFile;
                if (resolvedPdf === undefined) {
                    const candidate = item.file.replace('.json', '.pdf');
                    resolvedPdf = fs.existsSync(path.join(PDFS_DIR, candidate)) ? candidate : null;
                } else if (resolvedPdf && !fs.existsSync(path.join(PDFS_DIR, resolvedPdf))) {
                    resolvedPdf = null;
                }

                const record = {
                    file: item.file,
                    url: data.url || '',
                    profileName: data.profileName || '',
                    pdfFile: resolvedPdf,
                    dataScraping: data.dataScraping || '',
                    experienciaProfissional: exp || '',
                    mtime: item.mtime
                };

                // Indexa por URL canônica
                if (data.url) {
                    const cleanUrl = cleanLinkedInUrl(data.url).toLowerCase();
                    if (cleanUrl) {
                        byUrl.set(cleanUrl, mergeScrapedRecords(byUrl.get(cleanUrl), record));
                    }

                    const slug = extractSlug(data.url);
                    if (slug) {
                        bySlug.set(slug, mergeScrapedRecords(bySlug.get(slug), record));
                    }
                }

                // Indexa por nome normalizado
                if (data.profileName) {
                    const norm = normalizeName(data.profileName);
                    if (norm) {
                        byName.set(norm, mergeScrapedRecords(byName.get(norm), record));
                    }
                }
            } catch (err) {}
        }
    } catch (e) {
        console.error('Erro ao ler pasta dados_json:', e.message);
    }

    return { byUrl, bySlug, byName };
}


/**
 * Carrega e faz o merge completo dos alunos FORMADOS em ADM e da Lista Geral de LinkedIn.
 * Produz a lista unificada com os cabeçalhos:
 *  - Matrícula
 *  - Nome do Aluno
 *  - Data de nascimento
 *  - Data de conclusão
 *  - Linkedin
 * E anexa o status de coleta e experiência profissional extraída se disponível.
 * 
 * @param {boolean} [forceReload=false]
 * @returns {Array<Object>}
 */
function loadUnifiedStudents(forceReload = false) {
    const now = Date.now();
    // Cache em memória por 10 segundos para resposta ultrarrápida da interface
    if (!forceReload && cachedStudentsList && (now - lastCacheTimestamp < 10000)) {
        return cachedStudentsList;
    }

    console.log('[alumniHandler] Carregando e unificando Formados em ADM com LinkedIn...');

    // 1. Localiza planilhas
    const admPath = findFileByPattern(/Alunos.*ADM.*\.xlsx$/i, 'Alunos de ADM - 2026-08-28.xlsx');
    const lkPath = findFileByPattern(/lista.*geral.*linkedin.*\.xlsx$/i, 'lista geral linkedin 2026-08-31.xlsx');

    const formadosMap = new Map(); // normName -> { matricula, nomeOriginal, dtNascimento, dtConclusao }
    const formadosList = []; // Array para busca segura por prefixo de nome

    if (admPath && fs.existsSync(admPath)) {
        try {
            const zipAdm = new AdmZip(fs.readFileSync(admPath));
            const ssAdm = parseSharedStrings(zipAdm);

            // Lê primordialmente a aba formados (sheet3.xml) e confere sheet1.xml para formados adicionais
            const sheetsWithGraduates = ['xl/worksheets/sheet3.xml', 'xl/worksheets/sheet1.xml'];

            for (const sPath of sheetsWithGraduates) {
                const rows = parseWorksheet(zipAdm, sPath, ssAdm);
                if (rows.length === 0) continue;

                const header = rows[0];
                const matrIdx = header.indexOf('MATR ALUNO');
                const nomeIdx = header.indexOf('NOME PESSOA');
                const dtNascIdx = header.indexOf('DT NASCIMENTO');
                const dtEvIdx = header.indexOf('DT EVASAO');
                const formaEvIdx = header.indexOf('FORMA EVASAO');
                const isSheet3 = sPath.includes('sheet3');

                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    const formaEvasao = (formaEvIdx !== -1 ? (r[formaEvIdx] || '') : '').trim();

                    // Se não for sheet3, só inclui se formaEvasao for Formatura
                    if (!isSheet3 && !/format/i.test(formaEvasao)) {
                        continue;
                    }

                    const nome = (r[nomeIdx] || '').trim();
                    const matricula = matrIdx !== -1 ? (r[matrIdx] || '').trim() : '';
                    const dtNasc = dtNascIdx !== -1 ? (r[dtNascIdx] || '').trim() : '';
                    const dtConclusao = dtEvIdx !== -1 ? (r[dtEvIdx] || '').trim() : '';

                    // Vital: apenas alunos que possuem matrícula sinalizada
                    if (nome && matricula) {
                        const norm = normalizeName(nome);
                        if (!formadosMap.has(norm)) {
                            const graduateData = {
                                norm,
                                matricula,
                                nomeOriginal: nome,
                                dtNascimento: dtNasc,
                                dtConclusao: dtConclusao
                            };
                            formadosMap.set(norm, graduateData);
                            formadosList.push(graduateData);
                        }
                    }
                }
            }
            console.log(`[alumniHandler] Planilha ADM (Formados): ${formadosMap.size} formados com matrícula carregados.`);
        } catch (e) {
            console.error('[alumniHandler] Erro ao processar formados de ADM:', e.message);
        }
    } else {
        console.warn('[alumniHandler] Planilha de ADM não encontrada em:', admPath);
    }

    // 2. Carrega lista geral do LinkedIn e cruza exclusivamente com os Formados de ADM
    const lkFormados = [];
    const seenNames = new Set();
    const seenUrls = new Set();

    if (lkPath && fs.existsSync(lkPath)) {
        try {
            const zipLk = new AdmZip(fs.readFileSync(lkPath));
            const ssLk = parseSharedStrings(zipLk);

            // Lê as abas comp linkedin (sheet1) e comp geral (sheet3)
            const sheetsToRead = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml'];
            for (const sPath of sheetsToRead) {
                const rows = parseWorksheet(zipLk, sPath, ssLk);
                for (let i = 1; i < rows.length; i++) {
                    const r = rows[i];
                    const nome = (r[0] || '').trim();
                    const rawUrl = (r[1] || '').trim();

                    if (!nome || !rawUrl || !rawUrl.toLowerCase().includes('linkedin.com')) {
                        continue;
                    }

                    const cleanUrl = cleanLinkedInUrl(rawUrl);
                    const normName = normalizeName(nome);
                    const urlKey = cleanUrl.toLowerCase();

                    // Deduplica por URL ou nome normalizado
                    if (seenNames.has(normName) || seenUrls.has(urlKey)) {
                        continue;
                    }

                    // Cruza com os Formados de ADM (casamento exato ou prefixo inequívoco)
                    let formado = formadosMap.get(normName);
                    if (!formado && normName.includes(' ')) {
                        const prefixCand = formadosList.filter(a => a.norm.startsWith(normName + ' '));
                        if (prefixCand.length === 1) {
                            formado = prefixCand[0];
                        }
                    }

                    // VITAL: Mantém estritamente quem é FORMADO em ADM com matrícula
                    if (!formado) {
                        continue;
                    }

                    seenNames.add(normName);
                    seenUrls.add(urlKey);

                    lkFormados.push({
                        matricula: formado.matricula,
                        nome: formado.nomeOriginal,
                        dt_nascimento: formado.dtNascimento,
                        dt_conclusao: formado.dtConclusao,
                        linkedin: cleanUrl,
                        isAdm: true,
                        isFormado: true
                    });
                }
            }
            console.log(`[alumniHandler] Cruzamento Formados em ADM x LinkedIn: ${lkFormados.length} egressos únicos.`);
        } catch (e) {
            console.error('[alumniHandler] Erro ao processar planilha do LinkedIn:', e.message);
        }
    } else {
        console.warn('[alumniHandler] Planilha do LinkedIn não encontrada em:', lkPath);
    }

    // 3. Cruza com os perfis já raspados em dados_json/
    const { byUrl: scrapedByUrl, bySlug: scrapedBySlug, byName: scrapedByName } = getScrapedProfilesIndex();

    const unifiedList = lkFormados.map((st, index) => {
        const normName = normalizeName(st.nome);
        const urlKey = cleanLinkedInUrl(st.linkedin).toLowerCase();
        const slug = extractSlug(st.linkedin);

        const scraped = (slug ? scrapedBySlug.get(slug) : null) || scrapedByUrl.get(urlKey) || scrapedByName.get(normName);

        return {
            id: index + 1,
            matricula: st.matricula,
            nome: st.nome,
            dt_nascimento: st.dt_nascimento,
            dt_conclusao: st.dt_conclusao || '',
            linkedin: st.linkedin,
            isAdm: true,
            isFormado: true,
            scraped: !!scraped,
            jsonFile: scraped ? scraped.file : null,
            pdfFile: scraped ? scraped.pdfFile : null,
            dataScraping: scraped ? scraped.dataScraping : null,
            experienciaProfissional: scraped ? scraped.experienciaProfissional : ''
        };
    });

    cachedStudentsList = unifiedList;
    lastCacheTimestamp = Date.now();
    return unifiedList;
}

/**
 * Retorna estatísticas gerais e a lista filtrada de formados.
 */
function getStudentsOverview(options = {}) {
    const list = loadUnifiedStudents(options.forceReload || false);

    const total = list.length;
    const totalAdm = list.length; // 100% são formados em ADM com matrícula
    const totalScraped = list.filter(s => s.scraped).length;
    const totalPending = total - totalScraped;

    let filtered = list;

    // Filtro por texto de busca (nome, matrícula ou link)
    if (options.query && typeof options.query === 'string') {
        const q = normalizeName(options.query);
        const rawQ = options.query.toLowerCase().trim();
        filtered = filtered.filter(s => 
            normalizeName(s.nome).includes(q) ||
            s.matricula.toLowerCase().includes(rawQ) ||
            s.linkedin.toLowerCase().includes(rawQ)
        );
    }

    // Filtro por curso ADM
    if (options.onlyAdm) {
        filtered = filtered.filter(s => s.isAdm);
    }

    // Filtro por status
    if (options.status === 'scraped') {
        filtered = filtered.filter(s => s.scraped);
    } else if (options.status === 'pending') {
        filtered = filtered.filter(s => !s.scraped);
    }

    return {
        total,
        totalAdm,
        totalScraped,
        totalPending,
        filteredCount: filtered.length,
        students: filtered
    };
}

/**
 * Escapa uma célula de texto para o formato CSV.
 * Se contiver aspas duplas, quebras de linha ou ponto-e-vírgula, envolve entre aspas duplas
 * e duplica as aspas internas.
 * 
 * @param {string} val
 * @returns {string}
 */
function escapeCsvCell(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return '"' + str.replace(/"/g, '""') + '"';
}

/**
 * Decompõe o texto consolidado de experiências em itens estruturados individuais,
 * identificando os cargos, empresas, períodos (início/término/tempo) e descrições verbatim.
 * 
 * @param {string} text - Texto consolidado de experiências
 * @returns {Array<{ experiencia: string, periodo: string }>}
 */
function parseExperienceItems(text) {
    if (!text || typeof text !== 'string') return [];
    const cleaned = text.replace(/\r\n/g, '\n').trim();
    if (!cleaned) return [];

    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];

    // Regex para identificar linhas de período com suporte a múltiplos idiomas (PT, EN, FR, ES)
    const periodRegex = /(?:(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez|janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|août|mars|juin|juil|sept|déc)\w*\s+(?:de\s+)?\d{4}|\b\d{4}\b)\s*[-–—]\s*(?:o momento|presente|present|actuel|\w+\s+(?:de\s+)?\d{4}|\b\d{4}\b)/i;

    const periodIndices = [];
    for (let i = 0; i < lines.length; i++) {
        if (periodRegex.test(lines[i])) {
            periodIndices.push(i);
        }
    }

    if (periodIndices.length === 0) {
        return [{
            experiencia: cleaned,
            periodo: ''
        }];
    }

    const items = [];
    let currentCompany = '';

    for (let p = 0; p < periodIndices.length; p++) {
        const pIdx = periodIndices[p];
        const prevPIdx = p > 0 ? periodIndices[p - 1] : -1;
        const nextPIdx = p < periodIndices.length - 1 ? periodIndices[p + 1] : lines.length;

        const periodo = lines[pIdx];

        // Linhas candidatas a cabeçalho (cargo / empresa) entre o período anterior e o atual
        const candidateLines = lines.slice(prevPIdx + 1, pIdx).filter(l => {
            if (/^[-*•·]/.test(l)) return false;
            return true;
        });

        let cargo = '';
        let empresa = '';

        if (candidateLines.length === 1) {
            cargo = candidateLines[0];
            empresa = currentCompany;
        } else if (candidateLines.length === 2) {
            cargo = candidateLines[0];
            empresa = candidateLines[1];
        } else if (candidateLines.length >= 3) {
            const first = candidateLines[0];
            if (!/tempo integral|estágio|meio período|autônomo|freelance|no local|presencial|remoto|híbrido/i.test(first) && !/\d+\s+(?:ano|mês|mes|anos|meses)/i.test(first)) {
                currentCompany = first;
            }
            cargo = candidateLines[candidateLines.length - 2];
            empresa = candidateLines[candidateLines.length - 1];
        }

        if (empresa && !/tempo integral|estágio|meio período|no local|presencial|remoto|híbrido/i.test(empresa)) {
            currentCompany = empresa;
        }

        // Linhas de detalhes da experiência
        let detailsLines = [];
        for (let j = pIdx + 1; j < nextPIdx; j++) {
            const line = lines[j];
            const dist = nextPIdx - j;
            if (dist <= 2 && !/^[-*•·]/.test(line) && !/competências|skills/i.test(line)) {
                break;
            }
            detailsLines.push(line);
        }

        const expHeader = [cargo, empresa].filter(Boolean).join(' · ');
        const fullExp = [expHeader, detailsLines.join('\n')].filter(Boolean).join('\n');

        items.push({
            experiencia: fullExp || cargo || periodo,
            periodo: periodo
        });
    }

    return items;
}

/**
 * Gera o arquivo CSV consolidado com cada experiência e período em colunas individuais:
 * Matrícula;Nome do Aluno;Data de nascimento;Linkedin;Experiência 1;Período 1;Experiência 2;Período 2...
 * 
 * Exporta EXCLUSIVAMENTE os alunos FORMADOS em Administração (graduação concluída)
 * que possuem matrícula associada e perfil no LinkedIn.
 * 
 * Preserva integralmente todas as empresas, cargos, períodos e descrições sem inferência.
 * O arquivo é gerado com UTF-8 BOM (\uFEFF) para abertura nativa no Excel/Google Sheets.
 * 
 * @param {string} [outputPath] - Caminho opcional para salvar o CSV
 * @param {Object} [options={}] - Opções de exportação
 * @returns {string} Caminho do arquivo CSV gerado
 */
function exportStudentsToCsv(outputPath, options = {}) {
    const list = loadUnifiedStudents(true);

    const targetPath = outputPath || path.join(EXTERNAL_BASE_DIR, 'alunos_linkedin_experiencias.csv');

    // Decompõe as experiências de cada aluno em itens individuais
    const studentItemsMap = new Map();
    let maxExp = 0;

    for (const s of list) {
        const items = parseExperienceItems(s.experienciaProfissional);
        studentItemsMap.set(s.id, items);
        if (items.length > maxExp) {
            maxExp = items.length;
        }
    }

    // Se nenhum perfil tiver experiência, gera pelo menos 1 coluna de Experiência e Período
    const totalExpCols = Math.max(maxExp, 1);

    // Constrói o cabeçalho dinâmico com pares ordenados: Experiência N; Período N
    const headers = ['Matrícula', 'Nome do Aluno', 'Data de nascimento', 'Linkedin'];
    for (let i = 1; i <= totalExpCols; i++) {
        headers.push('Experiência ' + i);
        headers.push('Período ' + i);
    }

    const lines = [];
    lines.push(headers.map(escapeCsvCell).join(';'));

    // Adiciona linhas de alunos preenchendo as colunas dinâmicas
    for (const s of list) {
        const items = studentItemsMap.get(s.id) || [];
        const row = [
            s.matricula || '',
            s.nome || '',
            s.dt_nascimento || '',
            s.linkedin || ''
        ];

        for (let i = 0; i < totalExpCols; i++) {
            if (i < items.length) {
                row.push(items[i].experiencia || '');
                row.push(items[i].periodo || '');
            } else {
                row.push('');
                row.push('');
            }
        }

        lines.push(row.map(escapeCsvCell).join(';'));
    }

    // UTF-8 BOM (\uFEFF) para garantir caracteres acentuados no Excel brasileiro
    const csvContent = '\uFEFF' + lines.join('\r\n');
    fs.writeFileSync(targetPath, csvContent, 'utf8');

    // Salva também com nome explícito de Formados em ADM
    try {
        const admFileName = path.join(EXTERNAL_BASE_DIR, 'alunos_adm_formados_experiencias.csv');
        fs.writeFileSync(admFileName, csvContent, 'utf8');
    } catch (e) {}

    console.log(`[alumniHandler] Arquivo CSV exportado com sucesso (${list.length} Formados em ADM, ${totalExpCols} experiências dinâmicas): ${targetPath}`);
    return targetPath;
}

/**
 * Retorna as URLs dos perfis de Formados em ADM que ainda estão pendentes de coleta pelo scraper.
 */
function getPendingAdmUrls() {
    const list = loadUnifiedStudents(false);
    const pendingAdm = list.filter(s => !s.scraped && s.linkedin);
    return {
        totalAdm: list.length,
        pendingCount: pendingAdm.length,
        urls: pendingAdm.map(s => s.linkedin)
    };
}

module.exports = {
    loadUnifiedStudents,
    getStudentsOverview,
    exportStudentsToCsv,
    getPendingAdmUrls,
    parseExperienceItems,
    extractExperienceFromText,
    cleanLinkedInUrl,
    normalizeName
};
