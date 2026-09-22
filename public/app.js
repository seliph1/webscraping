/**
 * ============================================================================
 * CONTROLADOR FRONTEND - LINKEDIN PROFILE SCRAPER & BASE DE ALUNOS
 * ============================================================================
 * Responsabilidades:
 *  1. Gerenciamento de abas:
 *     - 'single': Scraping de Perfil Único (com toggle headless)
 *     - 'batch': Scraping em Lote via SSE Stream (com toggle headless e tempo de pausa)
 *     - 'students': Base Unificada de Alunos & Links:
 *       "Matrícula - Nome do Aluno - Data de nascimento - Linkedin",
 *       status de coleta, visualização/cópia de experiências e exportação CSV.
 *  2. Disparo de requisições de scraping individual e em lote com opções configuráveis.
 *  3. Feedback visual em tempo real (barra de progresso, status individual por perfil).
 *  4. Painel de autenticação LinkedIn integrado (auth.js / auth.json).
 * ============================================================================
 */

(function() {
    'use strict';

    // Estado da interface
    let currentMode = 'single';
    let completedItems = 0;

    // Estado da Base de Alunos & Links
    let allStudents = [];
    let currentFilter = 'all'; // 'all', 'pending', 'scraped'
    let currentSearchQuery = '';
    let isStudentsLoaded = false;
    let activeModalStudent = null;
    let authPollingTimer = null;

    /**
     * Utilitário para escapar caracteres HTML prevenindo injeção de código (XSS).
     */
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Extrai um identificador legível a partir de uma URL do LinkedIn
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

    // ========================================================================
    // GERENCIAMENTO DE ABAS
    // ========================================================================

    /**
     * Alterna a visualização entre as abas da aplicação:
     *  - 'single': Scraping de perfil único
     *  - 'batch': Scraping em lote com progresso SSE
     *  - 'students': Base unificada de alunos & links com status de coleta
     * 
     * @param {string} mode - Identificador da aba
     */
    window.switchTab = function(mode) {
        currentMode = mode;

        const tabSingle = document.getElementById('tab-single');
        const tabBatch = document.getElementById('tab-batch');
        const tabStudents = document.getElementById('tab-students');

        const singleView = document.getElementById('single-view');
        const batchView = document.getElementById('batch-view');
        const studentsView = document.getElementById('students-view');
        const form = document.getElementById('scrape-form');
        const delayGroup = document.getElementById('delay-option-group');

        // Remove estado ativo de todos os botões de aba
        [tabSingle, tabBatch, tabStudents].forEach(function(t) {
            if (t) {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            }
        });

        // Oculta todas as telas
        if (singleView) singleView.classList.add('hidden');
        if (batchView) batchView.classList.add('hidden');
        if (studentsView) studentsView.classList.add('hidden');

        hideAllStates();

        // Ativa a tela selecionada
        if (mode === 'single') {
            if (tabSingle) { tabSingle.classList.add('active'); tabSingle.setAttribute('aria-selected', 'true'); }
            if (form) form.classList.remove('hidden');
            if (singleView) singleView.classList.remove('hidden');
            if (delayGroup) delayGroup.style.display = 'none'; // Pausa só faz sentido em lote
            const urlInput = document.getElementById('url');
            if (urlInput) urlInput.focus();
        } else if (mode === 'batch') {
            if (tabBatch) { tabBatch.classList.add('active'); tabBatch.setAttribute('aria-selected', 'true'); }
            if (form) form.classList.remove('hidden');
            if (batchView) batchView.classList.remove('hidden');
            if (delayGroup) delayGroup.style.display = 'flex';
            const urlsTextarea = document.getElementById('urls');
            if (urlsTextarea) urlsTextarea.focus();

            // Atualiza contagem pendente no botão
            fetch('/api/students/pending-adm-urls').then(r => r.json()).then(data => {
                if (data.success) {
                    const el = document.getElementById('batch-adm-count');
                    if (el) el.textContent = data.pendingCount;
                }
            }).catch(() => {});
        } else if (mode === 'students') {
            if (tabStudents) { tabStudents.classList.add('active'); tabStudents.setAttribute('aria-selected', 'true'); }
            if (form) form.classList.add('hidden');
            if (studentsView) studentsView.classList.remove('hidden');
            if (!isStudentsLoaded) {
                window.loadStudentsData();
            }
        }
    };

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
    // ABA: BASE DE ALUNOS & LINKS DO LINKEDIN
    // ========================================================================

    /**
     * Sincroniza a base de dados com as planilhas e arquivos salvos em disco.
     */
    window.syncStudentsData = async function() {
        const tbody = document.getElementById('students-table-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">Sincronizando com o disco e planilhas...</td></tr>';
        }

        try {
            await fetch('/api/students/sync', { method: 'POST' });
        } catch (e) {
            console.error('Erro ao sincronizar:', e);
        }
        await window.loadStudentsData(true);
    };

    /**
     * Carrega a lista consolidada de alunos e links a partir do backend.
     * @param {boolean} [force=false]
     */
    window.loadStudentsData = async function(force = false) {
        if (!force && isStudentsLoaded) return;

        const tbody = document.getElementById('students-table-body');
        if (tbody && (!allStudents || allStudents.length === 0)) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">Carregando base unificada de alunos...</td></tr>';
        }

        try {
            const res = await fetch('/api/students/list');
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Falha ao carregar dados dos alunos.');

            allStudents = data.students || [];
            isStudentsLoaded = true;

            const totalCount = data.total || allStudents.length;
            const scrapedCount = data.totalScraped !== undefined ? data.totalScraped : allStudents.filter(s => s.scraped).length;
            const pendingCount = data.totalPending !== undefined ? data.totalPending : (totalCount - scrapedCount);

            // Atualiza contadores dos cards
            const statTotal = document.getElementById('stat-students-total');
            const statScraped = document.getElementById('stat-students-scraped');
            const statPending = document.getElementById('stat-students-pending');

            if (statTotal) statTotal.textContent = totalCount;
            if (statScraped) statScraped.textContent = scrapedCount;
            if (statPending) statPending.textContent = pendingCount;

            // Atualiza contadores das pílulas
            const pillAll = document.getElementById('pill-count-all');
            const pillPending = document.getElementById('pill-count-pending');
            const pillScraped = document.getElementById('pill-count-scraped');

            if (pillAll) pillAll.textContent = totalCount;
            if (pillPending) pillPending.textContent = pendingCount;
            if (pillScraped) pillScraped.textContent = scrapedCount;

            // Atualiza contador no botão da aba Em Lote
            const batchAdmCountEl = document.getElementById('batch-adm-count');
            if (batchAdmCountEl) batchAdmCountEl.textContent = pendingCount;

            renderStudentsTable();
        } catch (err) {
            console.error('Erro ao carregar base de formados:', err);
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #DC2626; padding: 2rem;">' + escapeHtml(err.message || 'Erro ao carregar base de formados.') + '</td></tr>';
            }
        }
    };

    /**
     * Filtra a tabela em tempo real com base no texto digitado na barra de busca.
     */
    window.onStudentsSearchInput = function() {
        const input = document.getElementById('students-search-input');
        currentSearchQuery = input ? input.value.trim().toLowerCase() : '';
        renderStudentsTable();
    };

    /**
     * Alterna o filtro ativo por pílula (Todos os Formados / Pendentes de Coleta / Coletados).
     */
    window.setStudentsFilter = function(filter) {
        currentFilter = filter;
        document.querySelectorAll('.filter-pill').forEach(function(pill) {
            pill.classList.toggle('active', pill.getAttribute('data-filter') === filter);
        });
        renderStudentsTable();
    };

    /**
     * Retorna a lista de formados filtrada com base nos critérios ativos.
     */
    function getFilteredStudents() {
        return allStudents.filter(function(st) {
            if (currentFilter === 'pending' && st.scraped) return false;
            if (currentFilter === 'scraped' && !st.scraped) return false;

            if (currentSearchQuery) {
                const normName = (st.nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
                const matr = (st.matricula || '').toLowerCase();
                const lk = (st.linkedin || '').toLowerCase();
                if (!normName.includes(currentSearchQuery) && !matr.includes(currentSearchQuery) && !lk.includes(currentSearchQuery)) {
                    return false;
                }
            }
            return true;
        });
    }

    /**
     * Renderiza as linhas da tabela de formados.
     */
    function renderStudentsTable() {
        const tbody = document.getElementById('students-table-body');
        const counter = document.getElementById('students-counter-text');
        if (!tbody) return;

        const filtered = getFilteredStudents();

        if (counter) {
            counter.textContent = 'Exibindo ' + filtered.length + ' de ' + allStudents.length + ' formados em ADM';
        }

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">Nenhum formando encontrado para os critérios selecionados.</td></tr>';
            return;
        }

        let html = '';
        filtered.forEach(function(st, idx) {
            const statusBadge = st.scraped ?
                '<span class="badge-scraped">✓ Coletado</span>' :
                '<span class="badge-pending">Pendente</span>';

            let actionsHtml = '';
            if (st.scraped) {
                actionsHtml = '<div style="display: flex; gap: 0.35rem; justify-content: center;">';
                if (st.experienciaProfissional) {
                    actionsHtml += '<button type="button" class="secondary-btn btn-sm" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="openExperienceModal(' + st.id + ')" title="Ver experiências extraídas">📄 Experiência</button>';
                }
                if (st.pdfFile) {
                    actionsHtml += '<a href="/downloads/' + encodeURIComponent(st.pdfFile) + '" class="table-action-btn" target="_blank" download title="Baixar PDF original" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;">⬇ PDF</a>';
                }
                actionsHtml += '</div>';
            } else {
                actionsHtml = '<button type="button" class="primary-btn btn-sm" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;" onclick="scrapeSingleFromTable(\'' + escapeHtml(st.linkedin) + '\')" title="Realizar coleta deste perfil agora">⚡ Coletar</button>';
            }

            const lkShort = st.linkedin ? st.linkedin.replace(/^https?:\/\/(?:www.)?/, '') : '-';
            const lkLink = st.linkedin ?
                '<a href="' + escapeHtml(st.linkedin) + '" target="_blank" rel="noopener noreferrer" class="table-link table-link-url" title="' + escapeHtml(st.linkedin) + '">' + escapeHtml(lkShort) + ' ↗</a>' :
                '-';

            html += '<tr>' +
                '<td style="text-align: center; color: var(--text-muted); font-size: 0.75rem;">' + (idx + 1) + '</td>' +
                '<td><code style="font-weight: 600; color: #1E293B;">' + escapeHtml(st.matricula || '-') + '</code></td>' +
                '<td><strong class="person-name">' + escapeHtml(st.nome) + '</strong></td>' +
                '<td style="text-align: center;">' + (st.dt_nascimento ? escapeHtml(st.dt_nascimento) : '<span class="text-muted">-</span>') + '</td>' +
                '<td style="text-align: center; color: #0284C7; font-weight: 500;">' + (st.dt_conclusao ? escapeHtml(st.dt_conclusao) : '<span class="text-muted">-</span>') + '</td>' +
                '<td>' + lkLink + '</td>' +
                '<td style="text-align: center;">' + statusBadge + '</td>' +
                '<td style="text-align: center;">' + actionsHtml + '</td>' +
            '</tr>';
        });

        tbody.innerHTML = html;
    }

    /**
     * Carrega diretamente na caixa de texto da aba Em Lote os links pendentes de Formados em ADM.
     */
    window.loadPendingAdmLinksToBatch = async function() {
        const btn = document.getElementById('btn-load-adm-batch');
        if (btn) btn.disabled = true;
        try {
            let pendingUrls = [];

            // Tenta obter via endpoint dedicado
            try {
                const res = await fetch('/api/students/pending-adm-urls');
                if (res.ok) {
                    const data = await res.json();
                    if (data.success && Array.isArray(data.urls)) {
                        pendingUrls = data.urls;
                    }
                }
            } catch (errRoute) {}

            // Fallback resiliente caso o servidor ainda não tenha sido reiniciado
            if (pendingUrls.length === 0) {
                if (!allStudents || allStudents.length === 0) {
                    const res = await fetch('/api/students/list');
                    const data = await res.json();
                    if (data.success && data.students) {
                        allStudents = data.students;
                    }
                }
                pendingUrls = (allStudents || [])
                    .filter(function(st) { return !st.scraped && st.linkedin; })
                    .map(function(st) { return st.linkedin; });
            }

            if (pendingUrls.length > 0) {
                const urlsTextarea = document.getElementById('urls');
                if (urlsTextarea) {
                    urlsTextarea.value = pendingUrls.join('\n');
                }
                alert(pendingUrls.length + ' perfis de Formados em ADM pendentes de coleta foram carregados na lista!');
            } else {
                alert('Não há perfis de Formados em ADM pendentes de coleta.');
            }
        } catch (e) {
            console.error('Erro ao carregar URLs pendentes:', e);
            alert('Erro ao carregar links pendentes: ' + e.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    /**
     * Envia todos os links pendentes exclusivamente de Formados em ADM para a aba "Em Lote".
     */
    window.sendPendingAdmLinksToBatch = function() {
        const pendingAdm = allStudents.filter(function(st) { 
            return !st.scraped && st.linkedin; 
        });
        if (pendingAdm.length === 0) {
            alert('Não há perfis de Formados em ADM pendentes de coleta!');
            return;
        }

        const urls = pendingAdm.map(function(st) { return st.linkedin; });
        const urlsTextarea = document.getElementById('urls');
        if (urlsTextarea) {
            urlsTextarea.value = urls.join('\n');
        }

        window.switchTab('batch');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    // Mantém compatibilidade com chamada legada
    window.sendPendingLinksToBatch = window.sendPendingAdmLinksToBatch;

    /**
     * Preenche a URL na aba Perfil Único e navega para ela.
     */
    window.scrapeSingleFromTable = function(linkedinUrl) {
        if (!linkedinUrl) return;
        const urlInput = document.getElementById('url');
        if (urlInput) {
            urlInput.value = linkedinUrl;
        }
        window.switchTab('single');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    /**
     * Abre a modal com a Experiência Profissional completa extraída do perfil.
     */
    window.openExperienceModal = function(studentId) {
        const student = allStudents.find(function(s) { return s.id === studentId; });
        if (!student) return;

        activeModalStudent = student;
        const modal = document.getElementById('experience-modal');
        const nameEl = document.getElementById('modal-student-name');
        const subEl = document.getElementById('modal-student-sub');
        const preEl = document.getElementById('modal-experience-text');

        if (nameEl) nameEl.textContent = student.nome;
        if (subEl) {
            subEl.textContent = (student.matricula ? ('Matrícula: ' + student.matricula + ' | ') : '') +
                                (student.dt_nascimento ? ('Nascimento: ' + student.dt_nascimento + ' | ') : '') +
                                student.linkedin;
        }
        if (preEl) {
            preEl.textContent = student.experienciaProfissional || '(Nenhuma experiência extraída para este perfil)';
        }

        if (modal) modal.classList.remove('hidden');
    };

    /**
     * Fecha a modal de experiência.
     */
    window.closeExperienceModal = function(e) {
        if (e && e.target && e.target.id !== 'experience-modal') return;
        const modal = document.getElementById('experience-modal');
        if (modal) modal.classList.add('hidden');
        activeModalStudent = null;
    };

    /**
     * Copia o texto da experiência para a área de transferência.
     */
    window.copyModalExperience = function() {
        if (!activeModalStudent || !activeModalStudent.experienciaProfissional) return;
        navigator.clipboard.writeText(activeModalStudent.experienciaProfissional).then(function() {
            alert('Experiência copiada para a área de transferência com sucesso!');
        }).catch(function() {
            alert('Não foi possível copiar automaticamente para a área de transferência.');
        });
    };

    // ========================================================================
    // PROCESSAMENTO DE SCRAPING (SINGLE & BATCH COM HEADLESS & PAUSA)
    // ========================================================================

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

        const headlessToggle = document.getElementById('headless-toggle');
        const isHeadless = headlessToggle ? headlessToggle.checked : true;

        if (tabs) tabs.classList.add('hidden');
        if (form) form.classList.add('hidden');
        if (errorState) errorState.classList.add('hidden');
        if (loadingState) loadingState.classList.remove('hidden');

        try {
            const response = await fetch('/api/scrape', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    url: url,
                    headless: isHeadless
                })
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
                isStudentsLoaded = false; // Invalida cache para refletir coleta na tabela
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
        const batchActions = document.getElementById('batch-actions');
        const realtimeList = document.getElementById('realtime-list');
        const tabs = document.querySelector('.tabs');

        const rawUrls = urlsTextarea ? urlsTextarea.value.trim().split('\n') : [];
        const urls = rawUrls.map(function(u) { return u.trim(); }).filter(function(u) { return u.length > 0; });
        if (urls.length === 0) return;

        const headlessToggle = document.getElementById('headless-toggle');
        const isHeadless = headlessToggle ? headlessToggle.checked : true;

        const delayInput = document.getElementById('delay-seconds-input');
        const delaySec = delayInput ? (parseInt(delayInput.value, 10) || 2) : 2;

        if (tabs) tabs.classList.add('hidden');
        if (form) form.classList.add('hidden');
        if (errorState) errorState.classList.add('hidden');
        if (batchActions) batchActions.classList.remove('hidden');
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
                body: JSON.stringify({ 
                    urls: urls,
                    headless: isHeadless,
                    delaySeconds: delaySec
                })
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

            isStudentsLoaded = false; // Invalida cache de alunos após conclusão do lote

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
                completedItems++;
                updateProgressBar(completedItems, total);
                li.className = 'realtime-item is-success';
                dot.className = 'status-dot dot-green';
                const downloadUrl = '/downloads/' + encodeURIComponent(fileName);
                action.innerHTML = '<span class="item-status-text success"><a href="' + downloadUrl + '" download="' + escapeHtml(fileName) + '" title="Baixar PDF">⬇ ' + escapeHtml(fileName) + '</a></span>';
            } else if (status === 'failed') {
                completedItems++;
                updateProgressBar(completedItems, total);
                li.className = 'realtime-item is-failed';
                dot.className = 'status-dot dot-red';
                const displayErr = error ? (error.length > 30 ? (error.substring(0, 30) + '...') : error) : 'Erro';
                action.innerHTML = '<span class="item-status-text failed" title="' + escapeHtml(error) + '">' + escapeHtml(displayErr) + '</span>';
            }

        } else if (event.type === 'complete') {
            updateProgressBar(total, total);
            const batchActions = document.getElementById('batch-actions');
            if (batchActions) batchActions.classList.remove('hidden');
            
            const successCount = event.successCount || 0;
            const failCount = event.failCount || 0;
            const progressHeader = document.querySelector('.progress-header h3');
            if (progressHeader) {
                progressHeader.textContent = 'Lote Finalizado: ' + successCount + ' salvos, ' + failCount + ' falhas';
            }

        } else if (event.type === 'fatal_error') {
            const errorState = document.getElementById('error-state');
            const errorMessage = document.getElementById('error-message');
            const batchActions = document.getElementById('batch-actions');
            if (errorMessage) errorMessage.textContent = event.error || 'Erro fatal durante o processamento em lote.';
            if (errorState) errorState.classList.remove('hidden');
            if (batchActions) batchActions.classList.remove('hidden');
        }
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
    // GESTÃO DA SESSÃO LINKEDIN (auth.js & VERIFICAÇÃO)
    // ========================================================================

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
                        const userText = data.userName ? (' (' + data.userName + ')') : '';
                        const expText = data.fileInfo && data.fileInfo.expiresAt ? (' - Expira em ' + data.fileInfo.expiresAt) : '';
                        updateAuthUi('authenticated', 'Autenticado', 'Sessão ativa e confirmada no LinkedIn' + userText + expText + '.');
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
                    updateAuthUi('authenticated', 'Autenticado (Local)', 'Arquivo auth.json válido (expira em ' + (data.expiresAt || 'data futura') + '). Clique em "Verificar Sessão" para validar ao vivo.');
                } else if (data.exists && data.isExpired) {
                    updateAuthUi('unauthenticated', 'Sessão Expirada', 'A sessão em auth.json expirou em ' + data.expiresAt + '. Clique em "Executar auth.js" para renovar.');
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
            await fetch('/api/auth/save', { method: 'POST' });
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

    // ========================================================================
    // INICIALIZAÇÃO NO DOM READY
    // ========================================================================

    document.addEventListener('DOMContentLoaded', function() {
        // Inicializa a verificação de sessão do LinkedIn no carregamento
        window.checkLinkedInAuth(false);

        // Configuração inicial de visibilidade da opção de delay
        const delayGroup = document.getElementById('delay-option-group');
        if (delayGroup) {
            delayGroup.style.display = (currentMode === 'batch') ? 'flex' : 'none';
        }

        // Atualiza contagem inicial de alunos de ADM pendentes para o botão da aba Em Lote
        fetch('/api/students/pending-adm-urls').then(r => r.json()).then(data => {
            if (data.success) {
                const el = document.getElementById('batch-adm-count');
                if (el) el.textContent = data.pendingCount;
            }
        }).catch(() => {});

        // Listener do formulário unificado
        const form = document.getElementById('scrape-form');
        if (form) {
            form.addEventListener('submit', async function(e) {
                e.preventDefault();
                if (currentMode === 'single') {
                    await handleSingleScrape();
                } else if (currentMode === 'batch') {
                    await handleBatchScrapeStream();
                }
            });
        }
    });

})();
