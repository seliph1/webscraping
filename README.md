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

## 🖥️ Executando a Aplicação Web

Inicie o servidor local:

```bash
npm start
```

Acesse no seu navegador:
👉 **[http://localhost:3000](http://localhost:3000)**

---

## 📂 Estrutura do Projeto

```
├── auth.js               # Script para autenticação interativa e geração do auth.json
├── script.js             # Motor de scraping com Playwright e parsing de PDFs
├── server.js             # Servidor Express com API REST e streaming SSE
├── pbixHandler.js        # Consolidador semântico de dados e exportador CSV
├── pbixDecoder.js        # Decodificador VertiPaq / XPress9 (WASM) para arquivos .pbix
├── package.json          # Dependências e scripts de execução multiplataforma
├── egressos.pbix         # Arquivo do modelo Power BI integrado
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
| `npm start` | Inicia o servidor web na porta 3000 |
| `npm run auth` | Abre o navegador para autenticação manual no LinkedIn |
| `npm run install-browsers` | Baixa o Chromium do Playwright (Windows / macOS) |
| `npm run install-browsers:linux` | Baixa o Chromium e instala dependências do sistema operacional (Linux) |

