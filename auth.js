const { chromium } = require("playwright");
const { AUTH_PATH, getBrowsersPath, getChromiumExecutablePath } = require("./paths");

// Garante que utilize o Chromium embutido se disponível
const bundledBrowsersPath = getBrowsersPath();
if (bundledBrowsersPath && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsersPath;
}

(async () => {
    const launchOptions = {
        headless: false
    };
    const explicitExe = getChromiumExecutablePath();
    if (explicitExe) {
        launchOptions.executablePath = explicitExe;
    }

    const browser = await chromium.launch(launchOptions);

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://www.linkedin.com");

    console.log("Faça login manualmente.");
    console.log("Após terminar, pressione ENTER no terminal.");

    process.stdin.resume();

    process.stdin.once("data", async () => {
        await context.storageState({
            path: AUTH_PATH
        });

        console.log("Sessão salva em " + AUTH_PATH);

        await browser.close();
        process.exit(0);
    });
})();