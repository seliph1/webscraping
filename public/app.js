/**
 * ============================================================================
 * CONTROLADOR FRONTEND - LINKEDIN PROFILE SCRAPER & PBIX EXPLORER
 * ============================================================================
 * Responsabilidades:
 *  1. Gerenciamento de abas (Perfil Único, Em Lote, Registro de Dados, Explorador de Tabela).
 *  2. Disparo de requisições de scraping individual e em lote (via SSE Stream).
 *  3. Feedback visual dinâmico (barra de progresso, lista de itens da fila).
 *  4. Aba "Registro de Dados": Tabela com filtros, alternância de colunas, download de PDFs
 *     e links diretos para perfis do LinkedIn.
 *  5. Aba "Explorador de Tabela": Visualização em grade tabular completa de todos os
 *     dados reais (todas as 30 colunas e 321 linhas) extraídos de dentro do arquivo .pbix.
 * ============================================================================
 */

(function() {
    // Estado da interface
    let currentMode = 'single';
    let completedItems = 0;
    let allTableRows = [];
    let isModelLoaded = false;

    // Estado do Explorador de Tabela (dados reais do .pbix)
    let explorerColumns = [];
    let explorerRows = [];
    let isExplorerLoaded = false;

    /**
     * Definição das colunas disponíveis para a aba "Registro de Dados" (dados coletados).
     * O usuário pode ativar/desativar cada coluna dinamicamente na interface.
     */
    const availableColumns = [
        { key: 'Nomes', label: 'Nomes', active: true },
        { key: 'Cargo', label: 'Cargo', active: true },
        { key: 'Empresa', label: 'Empresa', active: true },
        { key: 'Área', label: 'Área', active: true },
        { key: 'Região (Cidade)', label: 'Região (Cidade)', active: true },
        { key: 'Coleta de Dados', label: 'Coleta de Dados', active: false },
        { key: 'STATUS', label: 'STATUS', active: false },
        { key: 'url', label: 'Perfil LinkedIn', active: true },
        { key: 'pdfFile', label: 'Documento PDF', active: true }
    ];

    /**
     * Extrai um identificador legível e limpo a partir de uma URL do LinkedIn
     * para exibição resumida na lista em tempo real do processamento em lote.
     */
    function getCleanIdentifier(rawUrl) {
        if (!rawUrl) return '';
        let clean = rawUrl.trim().split('?')[0].split('#')[0].replace(/\/+$/, '');
        if (clean.includes('/in/')) {
            const parts = clean.split('/in/');
            clean = parts[parts.length - 1];
        } else if (clean.includes('/')) {
            const parts = clean.split('/');
            clean = parts[parts.length - 1];
        }
        try {
            clean = decodeURIComponent(clean);
        } catch (e) {}
        return clean || rawUrl;
    }

    /**
     * Alterna a visualização entre as abas da aplicação:
     *  - 'single': Scraping de perfil único
     *  - 'batch': Scraping em lote com progresso SSE
     *  - 'pbix': Registro de Dados coletados
     *  - 'explorer': Explorador de Tabela do arquivo .pbix
     * 
     * @param {string} mode - Identificador da aba
     */
    window.switchTab = function(mode) {
        currentMode = mode;

        const tabSingle = document.getElementById('tab-single');
        const tabBatch = document.getElementById('tab-batch');
        const tabPbix = document.getElementById('tab-pbix');
        const tabExplorer = document.getElementById('tab-explorer');

        const singleView = document.getElementById('single-view');
        const batchView = document.getElementById('batch-view');
        const pbixView = document.getElementById('pbix-view');
        const explorerView = document.getElementById('explorer-view');
        const form = document.getElementById('scrape-form');

        // Remove estado ativo de todos os botões de aba
        [tabSingle, tabBatch, tabPbix, tabExplorer].forEach(function(t) {
            if (t) {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            }
        });

        // Oculta todas as telas
        if (singleView) singleView.classList.add('hidden');
        if (batchView) batchView.classList.add('hidden');
        if (pbixView) pbixView.classList.add('hidden');
        if (explorerView) explorerView.classList.add('hidden');

        // Ativa a tela selecionada
        if (mode === 'single') {
            if (tabSingle) { tabSingle.classList.add('active'); tabSingle.setAttribute('aria-selected', 'true'); }
            if (form) form.classList.remove('hidden');
            if (singleView) singleView.classList.remove('hidden');
            const urlInput = document.getElementById('url');
            if (urlInput) urlInput.focus();
        } else if (mode === 'batch') {
            if (tabBatch) { tabBatch.classList.add('active'); tabBatch.setAttribute('aria-selected', 'true'); }
            if (form) form.classList.remove('hidden');
            if (batchView) batchView.classList.remove('hidden');
            const urlsTextarea = document.getElementById('urls');
            if (urlsTextarea) urlsTextarea.focus();
        } else if (mode === 'pbix') {
            if (tabPbix) { tabPbix.classList.add('active'); tabPbix.setAttribute('aria-selected', 'true'); }
            if (form) form.classList.add('hidden');
            if (pbixView) pbixView.classList.remove('hidden');
            if (!isModelLoaded) {
                loadSemanticModel();
            }
        } else if (mode === 'explorer') {
            if (tabExplorer) { tabExplorer.classList.add('active'); tabExplorer.setAttribute('aria-selected', 'true'); }
            if (form) form.classList.add('hidden');
            if (explorerView) explorerView.classList.remove('hidden');
            if (!isExplorerLoaded) {
                loadTableExplorer();
            }
            // Sempre sincroniza com o arquivo mais recente no disco
            loadTableExplorer(true);
        }

        hideAllStates();
    };

    /**
     * Oculta os estados intermediários (loading, sucesso, erro, progresso).
     */
    function hideAllStates() {
        const elements = ['loading-state', 'progress-state', 'success-state', 'error-state'];
        elements.forEach(function(id) {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
        const tabs = document.querySelector('.tabs');
        if (tabs) tabs.classList.remove('hidden');
    }

    /**
     * Reseta o formulário de perfil único para novo scraping.
     */
    window.resetSingle = function() {
        hideAllStates();
        const form = document.getElementById('scrape-form');
        if (form) form.classList.remove('hidden');
        const urlInput = document.getElementById('url');
        if (urlInput) { urlInput.value = ''; urlInput.focus(); }
    };

    /**
     * Reseta o formulário em lote para novo lote de perfis.
     */
    window.resetBatch = function() {
        hideAllStates();
        const form = document.getElementById('scrape-form');
        if (form) form.classList.remove('hidden');
        completedItems = 0;
        const progressHeader = document.querySelector('.progress-header h3');
        if (progressHeader) progressHeader.textContent = 'Processamento em Lote';
        const urlsTextarea = document.getElementById('urls');
        if (urlsTextarea) { urlsTextarea.value = ''; urlsTextarea.focus(); }
    };

    // ========================================================================
    // ABA: REGISTRO DE DADOS (DADOS COLETADOS VIA SCRAPING)
    // ========================================================================

    /**
     * Carrega os dados coletados do backend e os metadados do arquivo .pbix.
     * @param {boolean} [force] - Se verdadeiro, força a recarga ignorando cache
     */
    window.loadSemanticModel = async function(force) {
        if (force) isModelLoaded = false;

        const statusBadge = document.getElementById('pbix-status-badge');
        const fileNameEl = document.getElementById('pbix-file-name');
        const filePathEl = document.getElementById('pbix-file-path');
        const tbody = document.getElementById('people-table-body');
        const currentTableTitle = document.getElementById('current-table-title');

        if (statusBadge) {
            statusBadge.className = 'status-badge';
            statusBadge.style.backgroundColor = '#E5E7EB';
            statusBadge.style.color = '#374151';
            statusBadge.textContent = 'Carregando...';
        }
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2rem;">Carregando modelo e dados da tabela...</td></tr>';
        }

        try {
            const res = await fetch('/api/pbix/table-data');
            const tableData = await res.json();

            const modelRes = await fetch('/api/pbix/model');
            const modelJson = await modelRes.json();

            if (!tableData.success) throw new Error(tableData.error || 'Falha ao carregar dados da tabela.');
            if (!modelJson.success) throw new Error(modelJson.error || 'Falha ao carregar modelo.');

            const model = modelJson.model;
            allTableRows = tableData.rows || [];
            isModelLoaded = true;

            if (currentTableTitle) {
                currentTableTitle.textContent = tableData.table || 'BASE BI';
            }

            if (fileNameEl) fileNameEl.textContent = model.fileName;
            if (filePathEl) filePathEl.innerHTML = 'Caminho configurado: <code>' + model.filePath + '</code> (' + (model.fileSizeFormatted || '-') + ')';

            if (statusBadge) {
                if (model.exists) {
                    statusBadge.className = 'status-badge success-badge';
                    statusBadge.textContent = '✓ Conectado ao PBIX';
                } else {
                    statusBadge.className = 'status-badge error-badge';
                    statusBadge.textContent = '! Arquivo não encontrado';
                }
            }

            const statPeople = document.getElementById('stat-people-count');
            const statTables = document.getElementById('stat-tables-count');
            const statCols = document.getElementById('stat-columns-count');
            const statPages = document.getElementById('stat-pages-count');

            if (statPeople) statPeople.textContent = allTableRows.length;
            if (statTables) statTables.textContent = model.tables ? model.tables.length : 0;
            if (statCols) statCols.textContent = model.columnsCount || 0;
            if (statPages) statPages.textContent = model.sectionsCount || 0;

            renderColumnToggles();
            renderTableData(allTableRows);
            renderModelDetails(model);

        } catch (err) {
            console.error('Erro ao carregar dados do registro:', err);
            if (statusBadge) {
                statusBadge.className = 'status-badge error-badge';
                statusBadge.textContent = '! Erro ao carregar';
            }
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: #DC2626; padding: 2rem;">' + (err.message || 'Erro ao carregar dados.') + '</td></tr>';
            }
        }
    };

    /**
     * Renderiza os botões tipo chip para alternar visibilidade de colunas.
     */
    function renderColumnToggles() {
        const container = document.getElementById('column-toggles-container');
        if (!container) return;

        let html = '';
        availableColumns.forEach(function(col, idx) {
            const activeClass = col.active ? ' active' : '';
            html += '<button type="button" class="col-toggle-btn' + activeClass + '" onclick="toggleColumn(' + idx + ')">' +
                (col.active ? '✓ ' : '+ ') + escapeHtml(col.label) +
            '</button>';
        });
        container.innerHTML = html;
    }

    /**
     * Alterna o estado ativo/inativo de uma coluna específica e re-renderiza a tabela.
     * @param {number} index - Índice da coluna no array availableColumns
     */
    window.toggleColumn = function(index) {
        if (availableColumns[index]) {
            availableColumns[index].active = !availableColumns[index].active;
            renderColumnToggles();
            filterPeopleTable();
        }
    };

    /**
     * Renderiza as linhas e cabeçalhos ativos na tabela da aba Registro de Dados.
     * @param {Array<Object>} rows - Lista de linhas a exibir
     */
    function renderTableData(rows) {
        const thead = document.getElementById('people-table-head');
        const tbody = document.getElementById('people-table-body');
        const counter = document.getElementById('people-counter-text');
        if (!thead || !tbody) return;

        const activeCols = availableColumns.filter(function(c) { return c.active; });

        let theadHtml = '<tr>';
        activeCols.forEach(function(col) {
            const centerStyle = (col.key === 'pdfFile' || col.key === 'STATUS') ? ' style="text-align: center;"' : '';
            theadHtml += '<th' + centerStyle + '>' + escapeHtml(col.label) + '</th>';
        });
        theadHtml += '</tr>';
        thead.innerHTML = theadHtml;

        if (!rows || rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="' + Math.max(1, activeCols.length) + '" style="text-align: center; color: var(--text-muted); padding: 2rem;">Nenhum registro encontrado com os filtros atuais.</td></tr>';
            if (counter) counter.textContent = 'Exibindo 0 de ' + allTableRows.length + ' registros | ' + activeCols.length + ' colunas ativas';
            return;
        }

        let tbodyHtml = '';
        rows.forEach(function(r) {
            tbodyHtml += '<tr>';
            activeCols.forEach(function(col) {
                const key = col.key;
                if (key === 'Nomes') {
                    tbodyHtml += '<td><strong class="person-name">' + escapeHtml(r['Nomes'] || '-') + '</strong></td>';
                } else if (key === 'Cargo') {
                    tbodyHtml += '<td class="person-headline">' + escapeHtml(r['Cargo'] || '-') + '</td>';
                } else if (key === 'Empresa') {
                    tbodyHtml += '<td><span class="company-badge">' + escapeHtml(r['Empresa'] || '-') + '</span></td>';
                } else if (key === 'Área') {
                    tbodyHtml += '<td><span class="area-badge">' + escapeHtml(r['Área'] || '-') + '</span></td>';
                } else if (key === 'Região (Cidade)') {
                    tbodyHtml += '<td class="text-muted">' + escapeHtml(r['Região (Cidade)'] || '-') + '</td>';
                } else if (key === 'Coleta de Dados') {
                    tbodyHtml += '<td>' + escapeHtml(r['Coleta de Dados'] || '-') + '</td>';
                } else if (key === 'STATUS') {
                    tbodyHtml += '<td style="text-align: center;"><span class="status-pill">' + escapeHtml(r['STATUS'] || 'Analisado') + '</span></td>';
                } else if (key === 'url') {
                    let displayUrl = r.url ? r.url.replace(/^https?:\/\/(?:www\.)?/, 'www.') : '';
                    const link = r.url ?
                        '<a href="' + escapeHtml(r.url) + '" class="table-link table-link-url" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(r.url) + '">' + escapeHtml(displayUrl) + ' ↗</a>' :
                        '<span class="text-muted">-</span>';
                    tbodyHtml += '<td>' + link + '</td>';
                } else if (key === 'pdfFile') {
                    const pdfBtn = r.pdfFile ?
                        '<a href="/downloads/' + encodeURIComponent(r.pdfFile) + '" class="table-action-btn" target="_blank" download title="Baixar ' + r.pdfFile + '">📄 PDF</a>' :
                        '<span class="text-muted">-</span>';
                    tbodyHtml += '<td style="text-align: center;">' + pdfBtn + '</td>';
                } else {
                    tbodyHtml += '<td>' + escapeHtml(r[key] || '-') + '</td>';
                }
            });
            tbodyHtml += '</tr>';
        });

        tbody.innerHTML = tbodyHtml;
        if (counter) {
            counter.textContent = 'Exibindo ' + rows.length + ' de ' + allTableRows.length + ' registros | ' + activeCols.length + ' colunas visíveis';
        }
    }

    /**
     * Filtra a tabela de pessoas em tempo real a partir do campo de busca.
     */
    window.filterPeopleTable = function() {
        const input = document.getElementById('people-search-input');
        if (!input) return;
        const q = input.value.trim().toLowerCase();
        if (!q) {
            renderTableData(allTableRows);
            return;
        }

        const filtered = allTableRows.filter(function(r) {
            return Object.keys(r).some(function(k) {
                const val = r[k];
                return val && typeof val === 'string' && val.toLowerCase().includes(q);
            });
        });

        renderTableData(filtered);
    };

    /**
     * Renderiza as informações complementares do modelo (tabelas e páginas visuais).
     */
    function renderModelDetails(model) {
        const tablesContainer = document.getElementById('model-tables-container');
        const sectionsContainer = document.getElementById('model-sections-container');

        if (tablesContainer) {
            let html = '';
            if (model.tables && model.tables.length > 0) {
                model.tables.forEach(function(t) {
                    html += '<div class="table-block">' +
                        '<div class="table-block-title">📊 Tabela: <strong>' + escapeHtml(t) + '</strong> (' + (model.columns ? model.columns.length : 0) + ' campos identificados)</div>' +
                        '<div class="column-chips">';
                    
                    const cols = (model.columns || []).filter(function(c) { return c.table === t; });
                    cols.forEach(function(c) {
                        const isPrimary = ['nomes', 'cargo', 'empresa', 'área', 'região (cidade)', 'coleta de dados', 'status'].includes(c.name.toLowerCase());
                        html += '<span class="col-chip' + (isPrimary ? ' is-primary' : '') + '">' + escapeHtml(c.name) + '</span>';
                    });
                    html += '</div></div>';
                });
            } else {
                html = '<p class="text-muted">Nenhuma tabela mapeada no modelo.</p>';
            }
            tablesContainer.innerHTML = html;
        }

        if (sectionsContainer) {
            let html = '';
            if (model.sections && model.sections.length > 0) {
                model.sections.forEach(function(s, idx) {
                    html += '<div class="section-item">' +
                        '<span class="section-badge">Página ' + (idx + 1) + '</span>' +
                        '<div class="section-info">' +
                            '<strong>' + escapeHtml(s.displayName) + '</strong>' +
                            '<span class="section-visuals-count">' + s.visualsCount + ' visuais</span>' +
                        '</div>' +
                    '</div>';
                });
            } else {
                html = '<p class="text-muted">Nenhuma página de relatório identificada.</p>';
            }
            sectionsContainer.innerHTML = html;
        }
    }

    // ========================================================================
    // ABA: EXPLORADOR DE TABELA (DADOS REAIS DO ARQUIVO .PBIX)
    // ========================================================================

    /**
     * Carrega a tabela real contida diretamente dentro do .pbix
     * decodificada pelo endpoint /api/pbix/real-table (VertiPaq/XPress9).
     * @param {boolean} [force] - Se verdadeiro, força a recarga do backend
     */
    window.loadTableExplorer = async function(force) {
        if (force) isExplorerLoaded = false;

        const tableBadge = document.getElementById('smeTableBadge');
        const activeTableName = document.getElementById('smeActiveTableName');
        const rowBadge = document.getElementById('smeRowBadge');
        const tbody = document.getElementById('smeGridTbody');
        const footer = document.getElementById('smeStatusFooter');

        if (rowBadge) rowBadge.textContent = 'Carregando dados do .pbix...';
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="15" style="text-align: center; color: var(--text-muted); padding: 2rem;">Carregando todas as linhas e cabeçalhos do arquivo .pbix...</td></tr>';
        }

        try {
            const res = await fetch('/api/pbix/real-table');
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Falha ao extrair tabela real do .pbix.');

            explorerColumns = data.columns || [];
            explorerRows = data.rows || [];
            isExplorerLoaded = true;

            const tableName = data.table || 'BASE BI';
            if (activeTableName) activeTableName.textContent = tableName;
            if (tableBadge) tableBadge.textContent = explorerRows.length;
            if (rowBadge) rowBadge.textContent = explorerRows.length + ' linhas • ' + explorerColumns.length + ' cabeçalhos';
            if (footer) footer.textContent = 'Tabela ' + tableName + ' contendo ' + explorerRows.length + ' linhas e ' + explorerColumns.length + ' cabeçalhos carregados diretamente do arquivo .pbix.';

            renderExplorerGrid(explorerRows);

        } catch (err) {
            console.error('Erro no Explorador de Tabela:', err);
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="15" style="text-align: center; color: #DC2626; padding: 2rem;">' + (err.message || 'Erro ao carregar tabela do .pbix.') + '</td></tr>';
            }
            if (rowBadge) rowBadge.textContent = 'Erro';
        }
    };

    /**
     * Renderiza a grade de dados do Explorador de Tabela contendo dinamicamente
     * todos os cabeçalhos (30 colunas) e todas as linhas (321 registros).
     * @param {Array<Object>} rows - Linhas a serem renderizadas
     */
    function renderExplorerGrid(rows) {
        const thead = document.getElementById('smeGridThead');
        const tbody = document.getElementById('smeGridTbody');
        const footer = document.getElementById('smeStatusFooter');
        if (!thead || !tbody) return;

        // Monta os cabeçalhos dinâmicos com TODAS as colunas encontradas no .pbix
        let theadHtml = '<tr><th style="width: 45px; text-align: center;">#</th>';
        explorerColumns.forEach(function(col) {
            theadHtml += '<th>' + escapeHtml(col) + '</th>';
        });
        theadHtml += '</tr>';
        thead.innerHTML = theadHtml;

        if (!rows || rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="' + (explorerColumns.length + 1) + '" style="text-align: center; color: var(--text-muted); padding: 2rem;">Nenhuma linha encontrada para o filtro.</td></tr>';
            if (footer) footer.textContent = 'Exibindo 0 de ' + explorerRows.length + ' linhas';
            return;
        }

        let html = '';
        rows.forEach(function(r, idx) {
            html += '<tr><td class="sme-cell-idx">' + (idx + 1) + '</td>';
            explorerColumns.forEach(function(col) {
                const val = r[col];
                if (val === null || val === undefined || val === '') {
                    html += '<td class="text-muted">-</td>';
                } else if (col === 'Nomes') {
                    html += '<td class="sme-cell-name">' + escapeHtml(val) + '</td>';
                } else if (col === 'LinkedIn' && typeof val === 'string' && val.includes('linkedin.com')) {
                    let url = val.trim();
                    if (!url.startsWith('http')) url = 'https://' + url;
                    html += '<td><a href="' + escapeHtml(url) + '" class="table-link" target="_blank" rel="noopener noreferrer">Acessar Perfil ↗</a></td>';
                } else if (col === 'STATUS') {
                    html += '<td style="text-align: center;"><span class="sme-badge-status">' + escapeHtml(val) + '</span></td>';
                } else {
                    html += '<td>' + escapeHtml(val) + '</td>';
                }
            });
            html += '</tr>';
        });

        tbody.innerHTML = html;
        if (footer) {
            footer.textContent = 'Exibindo ' + rows.length + ' de ' + explorerRows.length + ' linhas da tabela BASE BI (' + explorerColumns.length + ' cabeçalhos extraídos do .pbix)';
        }
    }

    /**
     * Filtra a tabela do explorador em tempo real por qualquer texto presente em qualquer coluna.
     */
    window.filterExplorerTable = function() {
        const input = document.getElementById('smeFilterInput');
        if (!input) return;
        const q = input.value.trim().toLowerCase();
        if (!q) {
            renderExplorerGrid(explorerRows);
            return;
        }

        const filtered = explorerRows.filter(function(r) {
            return explorerColumns.some(function(col) {
                const val = r[col];
                return val && String(val).toLowerCase().includes(q);
            });
        });

        renderExplorerGrid(filtered);
    };

    /**
     * Permite selecionar uma tabela na barra lateral do explorador.
     */
    window.selectExplorerTable = function(tableName) {
        loadTableExplorer(true);
    };

    /**
     * Função auxiliar de escape HTML para proteção contra injeção de código (XSS).
     */
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ========================================================================
    // PROCESSAMENTO DE FORMULÁRIO (SCRAPING ÚNICO E EM LOTE)
    // ========================================================================

    document.addEventListener('DOMContentLoaded', function() {
        // Inicializa a verificação de sessão do LinkedIn no carregamento
        if (typeof window.checkLinkedInAuth === 'function') {
            window.checkLinkedInAuth(false);
        }

        const form = document.getElementById('scrape-form');
        if (!form) return;
        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            if (currentMode === 'single') {
                await handleSingleScrape();
            } else if (currentMode === 'batch') {
                await handleBatchScrapeStream();
            }
        });
    });

    /**
     * Executa a requisição de scraping para um único perfil.
     */
    async function handleSingleScrape() {
        const urlInput = document.getElementById('url');
        const form = document.getElementById('scrape-form');
        const loadingState = document.getElementById('loading-state');
        const successState = document.getElementById('success-state');
        const errorState = document.getElementById('error-state');
        const errorMessage = document.getElementById('error-message');
        const successMessage = document.getElementById('success-message');
        const downloadLink = document.getElementById('download-link');
        const singleDownload = document.getElementById('single-download');
        const tabs = document.querySelector('.tabs');

        const url = urlInput ? urlInput.value.trim() : '';
        if (!url) return;

        if (tabs) tabs.classList.add('hidden');
        if (form) form.classList.add('hidden');
        if (errorState) errorState.classList.add('hidden');
        if (loadingState) loadingState.classList.remove('hidden');

        try {
            const response = await fetch('/api/scrape', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url })
            });

            const data = await response.json();
            if (loadingState) loadingState.classList.add('hidden');

            if (data.success) {
                if (successMessage) successMessage.textContent = 'Perfil salvo com sucesso como "' + data.fileName + '"!';
                if (downloadLink) {
                    downloadLink.href = data.downloadUrl;
                    downloadLink.setAttribute('download', data.fileName);
                }
                if (singleDownload) singleDownload.classList.remove('hidden');
                if (successState) successState.classList.remove('hidden');
                isModelLoaded = false;
            } else {
                throw new Error(data.error || 'Ocorreu um erro no processamento.');
            }
        } catch (error) {
            if (loadingState) loadingState.classList.add('hidden');
            if (errorMessage) errorMessage.textContent = error.message;
            if (errorState) errorState.classList.remove('hidden');
            if (form) form.classList.remove('hidden');
            if (tabs) tabs.classList.remove('hidden');
        }
    }

    /**
     * Executa o processamento em lote com streaming de eventos SSE em tempo real.
     */
    async function handleBatchScrapeStream() {
        const urlsTextarea = document.getElementById('urls');
        const form = document.getElementById('scrape-form');
        const progressState = document.getElementById('progress-state');
        const errorState = document.getElementById('error-state');
        const errorMessage = document.getElementById('error-message');
        const batchActions = document.getElementById('batch-actions');
        const realtimeList = document.getElementById('realtime-list');
        const tabs = document.querySelector('.tabs');

        const rawUrls = urlsTextarea ? urlsTextarea.value.trim().split('\n') : [];
        const urls = rawUrls.map(function(u) { return u.trim(); }).filter(function(u) { return u.length > 0; });
        if (urls.length === 0) return;

        if (tabs) tabs.classList.add('hidden');
        if (form) form.classList.add('hidden');
        if (errorState) errorState.classList.add('hidden');
        if (batchActions) batchActions.classList.add('hidden');
        if (progressState) progressState.classList.remove('hidden');

        const total = urls.length;
        completedItems = 0;
        updateProgressBar(0, total);

        if (realtimeList) {
            realtimeList.innerHTML = '';
            urls.forEach(function(u, idx) {
                const li = document.createElement('li');
                li.id = 'item-' + idx;
                li.className = 'realtime-item';
                const displayId = getCleanIdentifier(u);
                li.innerHTML = 
                    '<div class="item-left">' +
                        '<span class="status-dot dot-gray" id="dot-' + idx + '"></span>' +
                        '<span class="item-url" title="' + escapeHtml(u) + '">' + escapeHtml(displayId) + '</span>' +
                    '</div>' +
                    '<div class="item-right" id="action-' + idx + '">' +
                        '<span class="item-status-text pending">Na Fila</span>' +
                    '</div>';
                realtimeList.appendChild(li);
            });
        }

        try {
            const response = await fetch('/api/scrape-batch-stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: urls })
            });

            if (!response.ok) {
                throw new Error('Erro na resposta do servidor: ' + response.statusText);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const streamRes = await reader.read();
                if (streamRes.done) break;

                buffer += decoder.decode(streamRes.value, { stream: true });
                const parts = buffer.split('\n\n');
                buffer = parts.pop();

                for (let p = 0; p < parts.length; p++) {
                    const lines = parts[p].split('\n');
                    for (let l = 0; l < lines.length; l++) {
                        const trimmed = lines[l].trim();
                        if (trimmed.startsWith('data:')) {
                            const jsonStr = trimmed.slice(5).trim();
                            try {
                                const event = JSON.parse(jsonStr);
                                handleStreamEvent(event, total);
                            } catch (err) {
                                console.error('Erro ao fazer parse do SSE:', err, jsonStr);
                            }
                        }
                    }
                }
            }

        } catch (error) {
            const errorStateEr = document.getElementById('error-state');
            const errorMsgEr = document.getElementById('error-message');
            const batchActs = document.getElementById('batch-actions');
            const progressHeader = document.querySelector('.progress-header h3');
            console.error('Erro no streaming em lote:', error);
            if (errorMsgEr) errorMsgEr.textContent = error.message || 'Erro durante o processamento em lote.';
            if (errorStateEr) errorStateEr.classList.remove('hidden');
            if (batchActs) batchActs.classList.remove('hidden');
            if (progressHeader) progressHeader.textContent = 'Processamento em Lote (Interrompido)';
        }
    }

    /**
     * Manipula cada evento individual transmitido pelo backend via SSE.
     */
    function handleStreamEvent(event, total) {
        if (event.type === 'progress') {
            const index = event.index;
            const status = event.status;
            const fileName = event.fileName;
            const downloadUrl = event.downloadUrl;
            const error = event.error;

            const li = document.getElementById('item-' + index);
            const dot = document.getElementById('dot-' + index);
            const action = document.getElementById('action-' + index);

            if (!li || !dot || !action) return;

            li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            if (status === 'processing') {
                li.className = 'realtime-item is-processing';
                dot.className = 'status-dot dot-yellow pulse';
                action.innerHTML = '<span class="item-status-text processing">Processando...</span>';
            } else if (status === 'success') {
                li.className = 'realtime-item is-success';
                dot.className = 'status-dot dot-green';
                const dlUrl = downloadUrl || ('/downloads/' + fileName);
                action.innerHTML = 
                    '<span class="item-status-text success">' +
                        '<a href="' + dlUrl + '" download="' + fileName + '" title="Baixar ' + fileName + '">Baixar PDF</a>' +
                    '</span>';
                updateProgressCounter(total);
                isModelLoaded = false;
            } else if (status === 'failed') {
                li.className = 'realtime-item is-failed';
                dot.className = 'status-dot dot-red';
                const shortErr = error ? (error.length > 25 ? error.substring(0, 22) + '...' : error) : 'Falhou';
                const safeErr = escapeHtml(error || '');
                action.innerHTML = '<span class="item-status-text failed" title="' + safeErr + '">' + shortErr + '</span>';
                updateProgressCounter(total);
            }
        } else if (event.type === 'complete') {
            updateProgressBar(total, total);
            const batchActions = document.getElementById('batch-actions');
            if (batchActions) batchActions.classList.remove('hidden');
            
            const successCount = event.successCount || 0;
            const failCount = event.failCount || 0;
            const progressHeader = document.querySelector('.progress-header h3');
            if (progressHeader) {
                progressHeader.textContent = 'Lote Finalizado (' + successCount + ' salvos, ' + failCount + ' pulados)';
            }
        }
    }

    /**
     * Incrementa o contador de progresso de perfis processados.
     */
    function updateProgressCounter(total) {
        completedItems++;
        updateProgressBar(completedItems, total);
    }

    /**
     * Atualiza os elementos da barra de progresso e porcentagem na interface.
     */
    function updateProgressBar(completed, total) {
        const progressCount = document.getElementById('progress-count');
        const progressPercent = document.getElementById('progress-percent');
        const progressBarFill = document.getElementById('progress-bar-fill');

        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        if (progressCount) progressCount.textContent = completed + ' / ' + total;
        if (progressPercent) progressPercent.textContent = percent + '%';
        if (progressBarFill) progressBarFill.style.width = percent + '%';
    }

    // ========================================================================
    // GESTÃO DE AUTENTICAÇÃO LINKEDIN (auth.js & VERIFICAÇÃO)
    // ========================================================================
    let authPollingTimer = null;

    /**
     * Atualiza os elementos visuais do status de autenticação.
     * 
     * @param {string} state - 'checking' | 'authenticated' | 'warning' | 'unauthenticated'
     * @param {string} badgeText - Texto curto para o badge
     * @param {string} detailText - Texto descritivo / data de expiração / erro
     */
    function updateAuthUi(state, badgeText, detailText) {
        const badge = document.getElementById('auth-status-badge');
        const detail = document.getElementById('auth-status-detail');
        if (!badge || !detail) return;

        badge.className = 'status-badge';
        if (state === 'checking') {
            badge.classList.add('checking-badge');
            badge.innerHTML = '<span class="status-dot dot-gray"></span> ' + escapeHtml(badgeText || 'Verificando...');
        } else if (state === 'authenticated') {
            badge.classList.add('success-badge');
            badge.innerHTML = '<span class="status-dot dot-green"></span> ' + escapeHtml(badgeText || 'Autenticado');
        } else if (state === 'warning') {
            badge.classList.add('warning-badge');
            badge.innerHTML = '<span class="status-dot dot-yellow"></span> ' + escapeHtml(badgeText || 'Atenção');
        } else {
            badge.classList.add('error-badge');
            badge.innerHTML = '<span class="status-dot dot-red"></span> ' + escapeHtml(badgeText || 'Não autenticado');
        }

        detail.textContent = detailText || '';
    }

    /**
     * Alterna o visual do banner de login em andamento
     */
    function setAuthRunningUi(isRunning) {
        const banner = document.getElementById('auth-running-banner');
        const btnRun = document.getElementById('btn-run-auth');
        if (banner) {
            if (isRunning) banner.classList.remove('hidden');
            else banner.classList.add('hidden');
        }
        if (btnRun) {
            if (isRunning) {
                btnRun.disabled = true;
                btnRun.innerHTML = '<span class="btn-text">⏳ Aguardando Login...</span>';
            } else {
                btnRun.disabled = false;
                btnRun.innerHTML = '<span class="btn-text">⚡ Executar auth.js</span>';
            }
        }
    }

    /**
     * Consulta o status do auth.json ou realiza teste ao vivo no LinkedIn.
     * 
     * @param {boolean} [isLiveTest=false] - Se true, faz a requisição ativa para testar a sessão no LinkedIn.
     */
    window.checkLinkedInAuth = async function(isLiveTest = false) {
        const btnCheck = document.getElementById('btn-check-auth');
        if (btnCheck) {
            btnCheck.disabled = true;
            btnCheck.innerHTML = '<span class="btn-text">⏳ Testando...</span>';
        }

        updateAuthUi('checking', 'Verificando...', isLiveTest ? 'Testando conexão e sessão ao vivo no LinkedIn via Chromium...' : 'Verificando arquivo local auth.json...');

        try {
            if (isLiveTest) {
                // Teste de autenticação ao vivo no LinkedIn
                const resp = await fetch('/api/auth/verify', { method: 'POST' });
                const data = await resp.json();

                if (data.authenticated) {
                    if (data.warning) {
                        updateAuthUi('warning', 'Válido Local', data.reason);
                    } else {
                        const userText = data.userName ? ` (${data.userName})` : '';
                        const expText = data.fileInfo && data.fileInfo.expiresAt ? ` - Expira em ${data.fileInfo.expiresAt}` : '';
                        updateAuthUi('authenticated', 'Autenticado', `Sessão ativa e confirmada no LinkedIn${userText}${expText}.`);
                    }
                } else {
                    updateAuthUi('unauthenticated', 'Não Autenticado', data.reason || 'Sessão inválida ou expirada no LinkedIn.');
                }
            } else {
                // Verificação local rápida
                const resp = await fetch('/api/auth/status');
                const data = await resp.json();

                if (data.inProgress) {
                    setAuthRunningUi(true);
                } else {
                    setAuthRunningUi(false);
                }

                if (data.valid && !data.isExpired) {
                    updateAuthUi('authenticated', 'Autenticado (Local)', `Arquivo auth.json válido (expira em ${data.expiresAt || 'data futura'}). Clique em "Verificar Sessão" para validar ao vivo.`);
                } else if (data.exists && data.isExpired) {
                    updateAuthUi('unauthenticated', 'Sessão Expirada', `A sessão em auth.json expirou em ${data.expiresAt}. Clique em "Executar auth.js" para renovar.`);
                } else if (data.exists && !data.hasLiAt) {
                    updateAuthUi('unauthenticated', 'auth.json Incompleto', 'O cookie de login li_at não foi encontrado em auth.json. Clique em "Executar auth.js".');
                } else {
                    updateAuthUi('unauthenticated', 'Sem Sessão', 'Arquivo auth.json não encontrado. Clique em "Executar auth.js" para realizar o primeiro login.');
                }
            }
        } catch (err) {
            console.error('Erro ao verificar autenticação:', err);
            updateAuthUi('warning', 'Erro ao Verificar', 'Não foi possível contatar o servidor: ' + err.message);
        } finally {
            if (btnCheck) {
                btnCheck.disabled = false;
                btnCheck.innerHTML = '<span class="btn-text">🔍 Verificar Sessão</span>';
            }
        }
    };

    /**
     * Dispara a execução do auth.js abrindo o navegador interativo.
     */
    window.startLinkedInAuth = async function() {
        const btnRun = document.getElementById('btn-run-auth');
        if (btnRun) {
            btnRun.disabled = true;
            btnRun.innerHTML = '<span class="btn-text">Iniciando...</span>';
        }

        try {
            const resp = await fetch('/api/auth/start', { method: 'POST' });
            const data = await resp.json();

            if (data.success) {
                setAuthRunningUi(true);
                updateAuthUi('checking', 'Login Aberto', 'Uma janela do navegador foi aberta. Faça login com sua conta do LinkedIn.');

                // Polling periódico para acompanhar conclusão automática do login
                if (authPollingTimer) clearInterval(authPollingTimer);
                authPollingTimer = setInterval(async () => {
                    try {
                        const statusResp = await fetch('/api/auth/status');
                        const statusData = await statusResp.json();
                        if (!statusData.inProgress) {
                            clearInterval(authPollingTimer);
                            authPollingTimer = null;
                            setAuthRunningUi(false);
                            window.checkLinkedInAuth(false);
                        }
                    } catch (e) {}
                }, 2000);
            } else {
                alert('Erro ao iniciar autenticação: ' + (data.error || 'Erro desconhecido.'));
                setAuthRunningUi(false);
            }
        } catch (err) {
            console.error('Falha ao acionar auth.js:', err);
            alert('Falha ao acionar auth.js: ' + err.message);
            setAuthRunningUi(false);
        }
    };

    /**
     * Força o salvamento imediato da sessão do navegador aberto.
     */
    window.saveLinkedInAuthNow = async function() {
        try {
            const resp = await fetch('/api/auth/save', { method: 'POST' });
            const data = await resp.json();
            if (authPollingTimer) clearInterval(authPollingTimer);
            setAuthRunningUi(false);
            setTimeout(() => {
                window.checkLinkedInAuth(false);
            }, 1000);
        } catch (err) {
            alert('Erro ao salvar sessão: ' + err.message);
        }
    };

    /**
     * Cancela o processo de login interativo e fecha o navegador aberto.
     */
    window.cancelLinkedInAuth = async function() {
        try {
            await fetch('/api/auth/cancel', { method: 'POST' });
            if (authPollingTimer) clearInterval(authPollingTimer);
            setAuthRunningUi(false);
            window.checkLinkedInAuth(false);
        } catch (err) {
            console.error('Erro ao cancelar:', err);
        }
    };
})();
