const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({
        headless: false
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://www.linkedin.com");

    console.log("Faça login manualmente.");
    console.log("Após terminar, pressione ENTER no terminal.");

    process.stdin.resume();

    process.stdin.once("data", async () => {
        await context.storageState({
            path: "auth.json"
        });

        console.log("Sessão salva em auth.json");

        await browser.close();
        process.exit(0);
    });
})();