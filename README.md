# LinkedIn Profile Scraper & Semantic Model Explorer

Aplicação completa para extração automatizada de perfis do LinkedIn em PDF e JSON, com interface web para scraping individual/em lote, consolidação semântica de dados e explorador de modelos do Power BI (.pbix VertiPaq/XPress9).

---

## 📋 Pré-requisitos

- **Node.js**: Versão 18 ou superior.
- **NPM**: Gerenciador de pacotes do Node.

---

## 🚀 Instalação Rápida

Clone ou copie a pasta do projeto para a sua máquina e execute os passos abaixo no terminal:

### 1. Instalar as dependências do projeto
```bash
npm install
```

### 2. Instalar o navegador Chromium do Playwright

- **No Windows / macOS**:
  ```bash
  npm run install-browsers
  ```

- **No Linux (Ubuntu/Debian, Fedora, etc.)**:
  O comando abaixo instala o Chromium e automaticamente todas as bibliotecas de sistema necessárias do SO:
  ```bash
  npm run install-browsers:linux
  ```

---

## 🔑 Autenticação no LinkedIn (auth.json)

Para realizar o scraping dos perfis, é necessário registrar a sessão autenticada:

```bash
npm run auth
```

1. Uma janela do navegador será aberta no LinkedIn.
2. Faça login normalmente com suas credenciais.
3. Após o login completo, volte ao terminal e pressione **ENTER**.
4. O arquivo `auth.json` será gerado com o estado da sessão (cookies e tokens).

> ⚠️ **Importante**: O arquivo `auth.json` contém suas credenciais de sessão e já está configurado no `.gitignore` para não ser versionado publicamente.

---

## 🖥️ Executando a Aplicação

Você pode executar o aplicativo de **duas formas**:

### Modo 1: Aplicativo Nativo de Desktop (Electron) — 2 Cliques!
Basta dar um duplo clique em um dos arquivos executáveis na raiz da pasta:
- 🚀 **`Iniciar-App.vbs`** *(Recomendado no Windows)*: Abre o aplicativo diretamente em uma janela nativa do Electron, **sem abrir nenhuma tela preta de terminal/PowerShell**.
- 🛠️ **`Iniciar.bat`**: Abre o aplicativo Electron mostrando o terminal com os logs do servidor em segundo plano.
- 🐧 **`iniciar.sh`**: Para execução direta em ambientes Linux (`./iniciar.sh`).

Ou, se preferir iniciar pelo terminal:
```bash
npm start
```

### Modo 2: Servidor Web Clássico (Acesso pelo Navegador)
Se quiser rodar apenas o servidor Express tradicional e acessar pelo seu navegador web padrão (Chrome, Edge, Firefox):
```bash
npm run web
```
Acesse: 👉 **[http://localhost:3000](http://localhost:3000)**

## 📦 Versão Pré-Compilada (Distribuição Standalone)

Se você deseja distribuir este aplicativo para outras máquinas **sem exigir que o usuário tenha o Node.js instalado** ou execute comandos no terminal, utilize a versão pré-compilada.

Os binários compilados ficam localizados na pasta `dist/`:

### 1. Executável Portátil Único (`.exe`)
- **Arquivo:** `dist/LinkedIn Scraper CEFET-RJ 1.0.0.exe`
- **Como usar:** Basta copiar este único arquivo `.exe` para qualquer computador com Windows e dar **dois cliques**. Ele não precisa de instalação prévia, cria o ambiente em tempo de execução e abre o aplicativo imediatamente.

### 2. Pasta Portátil Descompactada (`win-unpacked`)
- **Pasta:** `dist/win-unpacked/`
- **Executável:** `dist/win-unpacked/LinkedIn Scraper CEFET-RJ.exe`
- **Como usar:** É a aplicação já descompactada com todos os binários e dependências nativas pré-incluídos. Você pode compactar essa pasta em um arquivo `.zip` e distribuí-la. A inicialização é instantânea ao clicar duas vezes no executável.

### 3. Gerando Novos Pacotes Pré-Compilados
Para recompilar o projeto após alterações de código, utilize os scripts:

- **Gerar o executável portátil único (.exe):**
  ```bash
  npm run dist:portable
  ```
- **Gerar a pasta descompactada para Windows:**
  ```bash
  npm run dist:dir
  ```
- **Gerar o instalador padrão do Windows (NSIS Wizard):**
  ```bash
  npm run dist:win
  ```
- **Gerar pacote para Linux (`.AppImage`):**
  *(Recomendado executar em ambiente Linux ou WSL)*
  ```bash
  npm run dist:linux
  ```

> 💡 **Nota sobre o Playwright na máquina de destino:**
> O navegador Chromium para automação é gerenciado pelo Playwright. Caso a máquina de destino vá realizar a extração dos perfis no LinkedIn e ainda não possua o Chromium na pasta local (`%LOCALAPPDATA%\ms-playwright`), basta executar uma única vez `npx playwright install chromium` ou copiar a pasta do navegador.

---

## 📂 Estrutura do Projeto

```
├── auth.js               # Script para autenticação interativa e geração do auth.json
├── script.js             # Motor de scraping com Playwright e parsing de PDFs
├── server.js             # Servidor Express com API REST e streaming SSE
├── main.js               # Processo principal do Electron (janela nativa)
├── Iniciar-App.vbs        # Inicializador silencioso sem janela de terminal (Windows)
├── Iniciar.bat           # Inicializador em lote com logs de terminal (Windows)
├── iniciar.sh            # Inicializador para sistemas Linux / macOS
├── pbixHandler.js        # Consolidador semântico de dados e exportador CSV
├── pbixDecoder.js        # Decodificador VertiPaq / XPress9 (WASM) para arquivos .pbix
├── package.json          # Dependências e scripts de execução multiplataforma
├── egressos.pbix         # Arquivo do modelo Power BI integrado
├── dist/                 # Executáveis e pacotes pré-compilados para distribuição
├── local_api/
│   ├── bairros_brasil.json   # Base geográfica para validação de Região (Cidade)
│   ├── lista_cargos.json     # 2.871 cargos regulamentados no Brasil
│   ├── areas.json            # 42 áreas de atuação econômica padronizadas
│   └── cargos_por_area.json  # Base unificada relacionando cargos e áreas
├── public/               # Interface Web (HTML, CSS, JS)
├── dados_json/           # Arquivos JSON extraídos dos currículos
└── pdfs/                 # PDFs originais baixados do LinkedIn
```

---

## 🛠️ Scripts Disponíveis

| Comando | Descrição |
| :--- | :--- |
| `npm start` | Inicia o aplicativo nativo Electron |
| `npm run web` | Inicia somente o servidor Express (acesso via navegador em `http://localhost:3000`) |
| `npm run auth` | Abre o navegador interativo para autenticação manual no LinkedIn |
| `npm run install-browsers` | Baixa o Chromium do Playwright (Windows / macOS) |
| `npm run install-browsers:linux` | Baixa o Chromium e instala dependências de SO no Linux |
| `npm run dist:portable` | Compila o aplicativo como executável `.exe` único e portátil |
| `npm run dist:dir` | Compila o aplicativo na pasta descompactada `dist/win-unpacked` |
| `npm run dist:win` | Compila o instalador do Windows (NSIS `.exe`) |
| `npm run dist:linux` | Compila o pacote `.AppImage` para sistemas Linux |

