/**
 * ============================================================================
 * MÓDULO DE AUTENTICAÇÃO LINKEDIN & GESTÃO DA SESSÃO (auth.json)
 * ============================================================================
 * Fornece:
 *  1. Leitura e validação da integridade de 'auth.json' (cookie li_at e expiração).
 *  2. Verificação ao vivo da sessão no LinkedIn via Playwright headless.
 *  3. Execução do fluxo de login interativo (headless: false) com detecção
 *     automática de login e persistência da sessão.
 *  4. Compatibilidade total com execução via terminal (node auth.js / npm run auth).
 * ============================================================================
 */

const { chromium } = require("playwright");
const fs = require("fs");
const { AUTH_PATH, getBrowsersPath, getChromiumExecutablePath } = require("./paths");

// Garante que utilize o Chromium embutido se disponível
const bundledBrowsersPath = getBrowsersPath();
if (bundledBrowsersPath && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsersPath;
}

/**
 * Retorna opções de inicialização do Playwright Chromium
 */
function getLaunchOptions(overrides = {}) {
    const options = {
        ...overrides
    };
    const explicitExe = getChromiumExecutablePath();
    if (explicitExe) {
        options.executablePath = explicitExe;
    }
    return options;
}

/**
 * Inspeciona o arquivo auth.json localmente para checar existência,
 * integridade do JSON e validade temporal do cookie principal li_at.
 * 
 * @returns {Object} Informações detalhadas da sessão local
 */
function getAuthFileInfo() {
    if (!fs.existsSync(AUTH_PATH)) {
        return {
            exists: false,
            valid: false,
            message: 'Arquivo auth.json não encontrado. Realize a autenticação primeiro.',
            hasLiAt: false,
            isExpired: true,
            expiresAt: null,
            cookieCount: 0,
            filePath: AUTH_PATH
        };
    }

    try {
        const raw = fs.readFileSync(AUTH_PATH, 'utf8');
        const data = JSON.parse(raw);
        const cookies = Array.isArray(data.cookies) ? data.cookies : [];
        const liAtCookie = cookies.find(c => c.name === 'li_at');

        if (!liAtCookie) {
            return {
                exists: true,
                valid: false,
                message: 'Cookie li_at não encontrado em auth.json.',
                hasLiAt: false,
                isExpired: true,
                expiresAt: null,
                cookieCount: cookies.length,
                filePath: AUTH_PATH
            };
        }

        const nowSec = Date.now() / 1000;
        const isExpired = liAtCookie.expires > 0 && liAtCookie.expires < nowSec;
        const expiresDate = liAtCookie.expires > 0 ? new Date(liAtCookie.expires * 1000) : null;
        const formattedExpires = expiresDate ? expiresDate.toLocaleString('pt-BR') : 'Sem data de expiração';

        return {
            exists: true,
            valid: !isExpired,
            message: isExpired 
                ? `Sessão expirou em ${formattedExpires}. É necessário autenticar novamente.`
                : `Sessão válida até ${formattedExpires}.`,
            hasLiAt: true,
            isExpired,
            expiresAt: formattedExpires,
            cookieCount: cookies.length,
            filePath: AUTH_PATH
        };
    } catch (e) {
        return {
            exists: true,
            valid: false,
            message: 'Erro ao processar auth.json: ' + e.message,
            hasLiAt: false,
            isExpired: true,
            expiresAt: null,
            cookieCount: 0,
            filePath: AUTH_PATH
        };
    }
}

/**
 * Realiza uma verificação ao vivo da sessão no LinkedIn através de uma
 * navegação headless rápida com o contexto salvo em auth.json.
 * 
 * @returns {Promise<Object>} Resultado da verificação
 */
async function verifyLinkedInSession() {
    const fileInfo = getAuthFileInfo();
    if (!fileInfo.exists) {
        return {
            authenticated: false,
            status: 'missing_file',
            reason: 'Arquivo auth.json não encontrado. Faça o login clicando em "Executar auth.js".',
            fileInfo
        };
    }

    if (!fileInfo.valid || fileInfo.isExpired) {
        return {
            authenticated: false,
            status: 'expired',
            reason: fileInfo.message,
            fileInfo
        };
    }

    let browser = null;
    try {
        browser = await chromium.launch(getLaunchOptions({ headless: true }));
        const context = await browser.newContext({
            storageState: AUTH_PATH,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(15000);

        console.log('[Auth Verify] Testando sessão em https://www.linkedin.com/feed/ ...');
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });

        const finalUrl = page.url();
        console.log('[Auth Verify] URL resultante:', finalUrl);

        // Verifica redirecionamento para páginas de login / desafio / barreira
        const isAuthWallOrLogin = finalUrl.includes('/login') || 
                                  finalUrl.includes('/uas/') || 
                                  finalUrl.includes('/checkpoint') || 
                                  finalUrl.includes('/authwall');

        if (isAuthWallOrLogin) {
            return {
                authenticated: false,
                status: 'invalid_session',
                reason: 'A sessão expirou ou foi invalidada pelo LinkedIn (redirecionou para a página de login).',
                finalUrl,
                fileInfo
            };
        }

        // Tenta identificar o nome do usuário logado se possível
        let profileName = null;
        try {
            const nameEl = page.locator('.feed-identity-module__actor-meta, .profile-rail-card__actor-link, [data-view-name*="profile"]').first();
            if (await nameEl.isVisible({ timeout: 2000 }).catch(() => false)) {
                profileName = (await nameEl.innerText()).split('\n')[0].trim();
            }
        } catch (e) {}

        return {
            authenticated: true,
            status: 'authenticated',
            reason: 'Sessão ativa e validada com sucesso no LinkedIn.',
            profileName: profileName || 'Usuário Autenticado',
            finalUrl,
            fileInfo
        };
    } catch (err) {
        console.warn('[Auth Verify] Aviso durante teste ao vivo:', err.message);
        // Se a verificação ao vivo falhar por timeout ou ambiente, mas o arquivo local tem li_at não expirado:
        return {
            authenticated: true,
            warning: true,
            status: 'valid_local',
            reason: `Arquivo auth.json válido localmente (expira em ${fileInfo.expiresAt}). Aviso do teste ao vivo: ${err.message}`,
            fileInfo
        };
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

// Controle de sessão interativa única em execução
let activeAuthSession = null;

/**
 * Retorna true se houver uma sessão de autenticação ativa no navegador
 */
function isAuthRunning() {
    return activeAuthSession !== null;
}

/**
 * Inicia a sessão interativa de autenticação abrindo uma janela Chromium não-headless.
 * Monitora login automaticamente ou aguarda conclusão manual.
 * 
 * @param {Object} options - Callbacks opcionais { onStatus, onComplete, onError }
 */
async function startAuthSession({ onStatus, onComplete, onError } = {}) {
    if (activeAuthSession) {
        throw new Error('Uma janela de autenticação já está aberta no momento.');
    }

    let browser = null;
    let pollInterval = null;
    let isFinished = false;

    try {
        const launchOptions = getLaunchOptions({
            headless: false,
            slowMo: 100
        });

        browser = await chromium.launch(launchOptions);
        const context = await browser.newContext();
        const page = await context.newPage();

        const finishAndSave = async (source = 'auto') => {
            if (isFinished) return;
            isFinished = true;
            if (pollInterval) clearInterval(pollInterval);

            try {
                await context.storageState({ path: AUTH_PATH });
                console.log(`[Auth] Sessão gravada com sucesso em ${AUTH_PATH} (origem: ${source})`);
            } catch (err) {
                console.error('[Auth] Erro ao gravar storageState:', err.message);
            }

            // Aguarda um momento antes de fechar o navegador
            setTimeout(async () => {
                await browser.close().catch(() => {});
                activeAuthSession = null;
            }, 1500);

            if (onComplete) {
                onComplete({
                    success: true,
                    message: 'Autenticação concluída! Sessão salva com sucesso em auth.json.'
                });
            }
        };

        const cancelSession = async () => {
            if (isFinished) return;
            isFinished = true;
            if (pollInterval) clearInterval(pollInterval);
            await browser.close().catch(() => {});
            activeAuthSession = null;
            if (onStatus) {
                onStatus({ status: 'cancelled', message: 'Autenticação cancelada.' });
            }
        };

        activeAuthSession = {
            browser,
            context,
            page,
            startTime: Date.now(),
            save: () => finishAndSave('manual'),
            cancel: cancelSession
        };

        if (onStatus) {
            onStatus({ status: 'opened', message: 'Navegador aberto. Faça login no LinkedIn.' });
        }

        // Navega até a página de login do LinkedIn
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' }).catch(async () => {
            await page.goto('https://www.linkedin.com').catch(() => {});
        });

        // Evento caso o usuário feche a janela do navegador manualmente
        page.on('close', async () => {
            if (isFinished) return;
            // Se o usuário fechou a janela, verifica se o cookie li_at já havia sido emitido
            try {
                const cookies = await context.cookies();
                const hasLiAt = cookies.some(c => c.name === 'li_at');
                if (hasLiAt) {
                    await finishAndSave('window_close');
                } else {
                    isFinished = true;
                    if (pollInterval) clearInterval(pollInterval);
                    activeAuthSession = null;
                    if (onError) onError(new Error('A janela do navegador foi fechada antes do login ser finalizado.'));
                }
            } catch (e) {
                isFinished = true;
                if (pollInterval) clearInterval(pollInterval);
                activeAuthSession = null;
            }
        });

        // Polling para detectar automaticamente quando o login é concluído
        pollInterval = setInterval(async () => {
            if (isFinished || !activeAuthSession) {
                if (pollInterval) clearInterval(pollInterval);
                return;
            }
            try {
                const cookies = await context.cookies();
                const hasLiAt = cookies.some(c => c.name === 'li_at');
                const url = page.url();

                // Detecta login quando o cookie li_at está presente e a URL saiu da tela de login
                const isNotInLogin = !url.includes('/login') && !url.includes('/uas/') && !url.includes('/checkpoint');
                const isFeedOrProfile = url.includes('/feed') || url.includes('/in/') || url.includes('/mynetwork');

                if (hasLiAt && (isFeedOrProfile || isNotInLogin)) {
                    console.log('[Auth] Login detectado automaticamente com sucesso!');
                    if (onStatus) {
                        onStatus({ status: 'detected', message: 'Login detectado! Salvando sessão...' });
                    }
                    await finishAndSave('auto_detected');
                }
            } catch (e) {
                // Página em navegação ou fechando
            }
        }, 2000);

        return {
            success: true,
            message: 'Navegador aberto. Faça login na janela do LinkedIn.'
        };
    } catch (err) {
        if (pollInterval) clearInterval(pollInterval);
        if (browser) await browser.close().catch(() => {});
        activeAuthSession = null;
        if (onError) onError(err);
        throw err;
    }
}

/**
 * Cancela a sessão de autenticação ativa
 */
async function cancelAuthSession() {
    if (activeAuthSession && activeAuthSession.cancel) {
        await activeAuthSession.cancel();
        return { success: true, message: 'Autenticação cancelada.' };
    }
    return { success: false, message: 'Nenhuma sessão de autenticação em andamento.' };
}

/**
 * Força a gravação da sessão atual imediatamente
 */
async function saveCurrentAuthSession() {
    if (activeAuthSession && activeAuthSession.save) {
        await activeAuthSession.save();
        return { success: true, message: 'Sessão salva com sucesso.' };
    }
    return { success: false, message: 'Nenhuma sessão de autenticação em andamento.' };
}

// ============================================================================
// EXECUÇÃO DIRETA VIA CLI (node auth.js ou npm run auth)
// ============================================================================
if (require.main === module) {
    console.log('\n=============================================');
    console.log(' AUTENTICAÇÃO NO LINKEDIN (Playwright)');
    console.log('=============================================');
    console.log('1. A janela do navegador será aberta no LinkedIn.');
    console.log('2. Faça login normalmente com seu e-mail e senha.');
    console.log('3. A sessão será salva automaticamente ao concluir,');
    console.log('   ou você pode pressionar ENTER aqui para salvar.');
    console.log('=============================================\n');

    startAuthSession({
        onStatus: (st) => console.log('[Info]', st.message),
        onComplete: (res) => {
            console.log('\n✓ ' + res.message);
            console.log('Arquivo salvo em: ' + AUTH_PATH);
            process.exit(0);
        },
        onError: (err) => {
            console.error('\n✗ Erro:', err.message);
            process.exit(1);
        }
    }).then(() => {
        process.stdin.resume();
        process.stdin.once('data', async () => {
            if (activeAuthSession) {
                console.log('Gravando sessão via ENTER do teclado...');
                await activeAuthSession.save();
                process.exit(0);
            }
        });
    }).catch(err => {
        console.error('Falha ao abrir navegador:', err.message);
        process.exit(1);
    });
}

module.exports = {
    getAuthFileInfo,
    verifyLinkedInSession,
    startAuthSession,
    cancelAuthSession,
    saveCurrentAuthSession,
    isAuthRunning
};