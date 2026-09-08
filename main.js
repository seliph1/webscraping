const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const http = require('http');

const { getBrowsersPath, EXTERNAL_BASE_DIR } = require('./paths');

// Configura o caminho do Chromium embutido do Playwright
const browsersPath = getBrowsersPath();
if (browsersPath) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
}

let mainWindow = null;
const DEFAULT_PORT = 3000;

/**
 * Localiza uma porta TCP livre caso a porta padrão (3000) esteja ocupada.
 * 
 * @param {number} startPort - Porta inicial para testar
 * @returns {Promise<number>}
 */
function findAvailablePort(startPort) {
    return new Promise((resolve) => {
        const testServer = http.createServer();
        testServer.listen(startPort, () => {
            testServer.close(() => resolve(startPort));
        });
        testServer.on('error', () => {
            resolve(findAvailablePort(startPort + 1));
        });
    });
}

/**
 * Inicializa o servidor Express em background e abre a janela nativa do Electron.
 */
async function startServerAndApp() {
    try {
        const port = await findAvailablePort(DEFAULT_PORT);
        process.env.PORT = String(port);

        // Inicializa o servidor Express localmente
        require('./server.js');

        // Breve pausa para garantir que os middlewares e rotas estejam escutando
        await new Promise((res) => setTimeout(res, 400));

        // Cria a janela nativa do Electron
        mainWindow = new BrowserWindow({
            width: 1440,
            height: 920,
            minWidth: 1024,
            minHeight: 700,
            title: 'LinkedIn Scraper & Model Explorer - CEFET-RJ',
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        const appUrl = `http://localhost:${port}`;
        await mainWindow.loadURL(appUrl);

        mainWindow.on('closed', () => {
            mainWindow = null;
            app.quit();
        });

    } catch (error) {
        console.error('Erro ao inicializar a aplicação Electron:', error);
        dialog.showErrorBox('Erro de Inicialização', error.message || String(error));
        app.quit();
    }
}

app.whenReady().then(startServerAndApp);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        startServerAndApp();
    }
});

