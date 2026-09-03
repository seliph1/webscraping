(function() {
    let currentMode = 'single';
    let completedItems = 0;
    let allTableRows = [];
    let isModelLoaded = false;

    // Definição das colunas disponíveis para exploração da tabela
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

    function getCleanIdentifier(rawUrl) {
        if (!rawUrl) return '';
        let clean = rawUrl.trim().split('?')[0].split('#')[0].replace(/\+$/, '');
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

    window.switchTab = function(mode) {
        currentMode = mode;

        const tabSingle = document.getElementById('tab-single');
        const tabBatch = document.getElementById('tab-batch');
        const tabPbix = document.getElementById('tab-pbix');
        const singleView = document.getElementById('single-view');
        const batchView = document.getElementById('batch-view');
        const pbixView = document.getElementById('pbix-view');
        const form = document.getElementById('scrape-form');

        [tabSingle, tabBatch, tabPbix].forEach(function(t) {
            if (t) {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            }
        });

        if (singleView) singleView.classList.add('hidden');
        if (batchView) batchView.classList.add('hidden');
        if (pbixView) pbixView.classList.add('hidden');

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
        }

        hideAllStates();
    };

    function hideAllStates() {
        const elements = ['loading-state', 'progress-state', 'success-state', 'error-state'];
        elements.forEach(function(id) {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
        const tabs = document.querySelector('.tabs');
        if (tabs) tabs.classList.remove('hidden');
    }

    window.resetSingle = function() {
        hideAllStates();
        const form = document.getElementById('scrape-form');
        if (form) form.classList.remove('hidden');
        const urlInput = document.getElementById('url');
        if (urlInput) { urlInput.value = ''; urlInput.focus(); }
    };

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

    // ==========================================
    // Semantic Model & Table Explorer Functions
    // ==========================================

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

            // Atualiza cabeçalho do arquivo
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

            // Atualiza estatísticas
            const statPeople = document.getElementById('stat-people-count');
            const statTables = document.getElementById('stat-tables-count');
            const statCols = document.getElementById('stat-columns-count');
            const statPages = document.getElementById('stat-pages-count');

            if (statPeople) statPeople.textContent = allTableRows.length;
            if (statTables) statTables.textContent = model.tables ? model.tables.length : 0;
            if (statCols) statCols.textContent = model.columnsCount || 0;
            if (statPages) statPages.textContent = model.sectionsCount || 0;

            // Renderiza os seletores de colunas
            renderColumnToggles();

            // Renderiza tabela completa
            renderTableData(allTableRows);

            // Renderiza detalhes estruturais do modelo
            renderModelDetails(model);

        } catch (err) {
            console.error('Erro ao carregar explorador do PBIX:', err);
            if (statusBadge) {
                statusBadge.className = 'status-badge error-badge';
                statusBadge.textContent = '! Erro ao carregar';
            }
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: #DC2626; padding: 2rem;">' + (err.message || 'Erro ao carregar dados.') + '</td></tr>';
            }
        }
    };

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

    window.toggleColumn = function(index) {
        if (availableColumns[index]) {
            availableColumns[index].active = !availableColumns[index].active;
            renderColumnToggles();
            filterPeopleTable();
        }
    };

    function renderTableData(rows) {
        const thead = document.getElementById('people-table-head');
        const tbody = document.getElementById('people-table-body');
        const counter = document.getElementById('people-counter-text');
        if (!thead || !tbody) return;

        const activeCols = availableColumns.filter(function(c) { return c.active; });

        // Monta o thead dinâmico
        let theadHtml = '<tr>';
        activeCols.forEach(function(col) {
            const centerStyle = (col.key === 'pdfFile' || col.key === 'STATUS') ? ' style="text-align: center;"' : '';
            theadHtml += '<th' + centerStyle + '>' + escapeHtml(col.label) + '</th>';
        });
        theadHtml += '</tr>';
        thead.innerHTML = theadHtml;

        // Se não houver dados
        if (!rows || rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="' + Math.max(1, activeCols.length) + '" style="text-align: center; color: var(--text-muted); padding: 2rem;">Nenhum registro encontrado com os filtros atuais.</td></tr>';
            if (counter) counter.textContent = 'Exibindo 0 de ' + allTableRows.length + ' registros | ' + activeCols.length + ' colunas ativas';
            return;
        }

        // Monta as linhas da tabela
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
                    const link = r.url ?
                        '<a href="' + r.url + '" class="table-link" target="_blank" rel="noopener noreferrer">Acessar ↗</a>' :
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

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ==========================================
    // Scraping Handlers (Single & Batch)
    // ==========================================

    document.addEventListener('DOMContentLoaded', function() {
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

    function updateProgressCounter(total) {
        completedItems++;
        updateProgressBar(completedItems, total);
    }

    function updateProgressBar(completed, total) {
        const progressCount = document.getElementById('progress-count');
        const progressPercent = document.getElementById('progress-percent');
        const progressBarFill = document.getElementById('progress-bar-fill');

        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        if (progressCount) progressCount.textContent = completed + ' / ' + total;
        if (progressPercent) progressPercent.textContent = percent + '%';
        if (progressBarFill) progressBarFill.style.width = percent + '%';
    }
})();
