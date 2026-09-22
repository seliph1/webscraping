# LinkedIn Profile Scraper & Semantic Model Explorer
# LinkedIn Profile Scraper & Base de Alunos CEFET-RJ

Aplicação completa para extração automatizada de perfis do LinkedIn em PDF e JSON, com interface web para scraping individual/em lote, consolidação semântica de dados e explorador de modelos do Power BI (.pbix VertiPaq/XPress9).
Aplicação completa para extração estruturada de perfis do LinkedIn em PDF e JSON, com interface visual para scraping individual e em lote, consolidação de listas de alunos de Administração e outros cursos do CEFET-RJ, extração não-inferida de experiências profissionais e exportação direta em CSV para Excel.

---

## 📋 Funcionalidades Principais

1. **Base Unificada de Alunos & Links do LinkedIn:**
   - Cruza automaticamente as planilhas `Alunos de ADM - 2026-08-28.xlsx` e `lista geral linkedin 2026-08-31.xlsx`.
   - Ordenação estrita das colunas: `Matrícula - Nome do Aluno - Data de nascimento - Linkedin`.
   - Identifica se o perfil já foi coletado em `dados_json/` ou se está pendente.
   - Botão para transferir todos os links pendentes diretamente para o processamento em lote.

2. **Opções Flexíveis de Execução:**
   - **Modo Headless (Ativar/Desativar):** Permite executar em segundo plano (padrão) ou com a janela do navegador Chromium visível na tela para acompanhar cada clique e download ao vivo.
   - **Intervalo de Pausa Customizável:** Configuração de tempo de espera (em segundos) entre as requisições consecutivas no scraping em lote para evitar bloqueios ou rate limit do LinkedIn.

3. **Extração Fiel de Experiências Profissionais (Sem Inferências):**
   - Extrai **todas** as experiências do candidato (empresas, cargos, estágios, períodos de início e término exatamente como aparecem no perfil).
   - Sem suposições, descarte ou inferências heurísticas.
   - **Exportação CSV em Célula Única:** Gera arquivo CSV com `Matrícula;Nome do Aluno;Data de nascimento;Linkedin;Experiência Profissional`, onde todo o histórico profissional fica preservado em uma única célula multilinhas compatível com Excel, Google Sheets e Power BI (codificação UTF-8 BOM).

4. **Preservação de Bibliotecas do Power BI:**
   - As bibliotecas de decodificação VertiPaq / XPress9 (`pbixDecoder.js` e `pbixHandler.js`) e endpoints de API permanecem preservados no backend para futura integração com novos modelos do Power BI.

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
3. Após o login completo, volte ao terminal e pressione **ENTER** (ou utilize o botão "Salvar Sessão" na barra de autenticação da interface).
4. O arquivo `auth.json` será gerado com o estado da sessão (cookies e tokens).

> ⚠️ **Importante**: O arquivo `auth.json` contém suas credenciais de sessão e já está configurado no `.gitignore` para não ser versionado publicamente.

---

## 🖥️ Executando a Aplicação

Você pode executar o aplicativo de **duas formas**:

### Modo 1: Aplicativo Nativo de Desktop (Electron) — 2 Cliques!
Basta dar um duplo clique em um dos arquivos executáveis na raiz da pasta:
- 🚀 **`Iniciar-App.vbs`** *(Recomendado no Windows)*: Abre o aplicativo diretamente em uma janela nativa do Electron, **sem abrir nenhuma tela preta de terminal/PowerShell**.
- 🚀 **`Iniciar-App.vbs`** *(Recomendado no Windows)*: Abre o aplicativo diretamente em uma janela nativa do Electron, **sem abrir nenhuma tela preta de terminal**.
- 🛠️ **`Iniciar.bat`**: Abre o aplicativo Electron mostrando o terminal com os logs do servidor em segundo plano.
- 🐧 **`iniciar.sh`**: Para execução direta em ambientes Linux (`./iniciar.sh`).

Ou, se preferir iniciar pelo terminal:
Ou, pelo terminal:
```bash
npm start
```

### Modo 2: Servidor Web Clássico (Acesso pelo Navegador)
Se quiser rodar apenas o servidor Express tradicional e acessar pelo seu navegador web padrão (Chrome, Edge, Firefox):
```bash
npm run web
```
Acesse: 👉 **[http://localhost:3000](http://localhost:3000)**

---

## 📦 Versão Pré-Compilada (Distribuição Standalone)

Se você deseja distribuir este aplicativo para outras máquinas **sem exigir que o usuário tenha o Node.js instalado** ou execute comandos no terminal, utilize a versão pré-compilada.

Os binários compilados ficam localizados na pasta `dist/`:

### 1. Executável Portátil Único (`.exe`)
- **Arquivo:** `dist/LinkedIn Scraper CEFET-RJ 1.0.0.exe`
- **Como usar:** Basta copiar este único arquivo `.exe` para qualquer computador com Windows e dar **dois cliques**. Ele não precisa de instalação prévia, cria o ambiente em tempo de execução e abre o aplicativo imediatamente.
- **Tudo incluso:** O navegador Chromium do Playwright já está integrado diretamente ao pacote. A máquina de destino não precisa baixar nada na internet.
- **Pastas Externas:** Ao ser executado, as pastas `dados_json` e `pdfs` são salvas no mesmo diretório do executável, permitindo que você visualize e copie os arquivos diretamente pelo Windows Explorer.
- **Pastas e Arquivos Externos:** Ao ser executado, as pastas `dados_json` e `pdfs`, bem como os arquivos `auth.json` (credenciais da sessão) e `egressos.pbix` (modelo do Power BI) ficam no mesmo diretório do executável. Você pode substituir o arquivo `.pbix` por outro modelo atualizado ou copiar o `auth.json` diretamente pelo Windows Explorer.
- **Pastas e Arquivos Externos:** Ao ser executado, as pastas `dados_json` e `pdfs`, bem como os arquivos `auth.json` (credenciais da sessão) e `egressos.pbix` ficam no mesmo diretório do executável.

### 2. Pasta Portátil Descompactada (`win-unpacked`)
- **Pasta:** `dist/win-unpacked/`
- **Executável:** `dist/win-unpacked/LinkedIn Scraper CEFET-RJ.exe`
- **Como usar:** É a aplicação já descompactada com todos os binários e dependências nativas pré-incluídos (incluindo o Chromium em `resources/browsers/`). Você pode compactar essa pasta em um arquivo `.zip` e distribuí-la. A inicialização é instantânea ao clicar duas vezes no executável.

### 3. Gerando Novos Pacotes Pré-Compilados
Para recompilar o projeto após alterações de código, utilize os scripts:

- **Gerar o executável portátil único (.exe com Chromium integrado):**
  ```bash
  npm run dist:portable
  ```
- **Gerar a pasta descompactada para Windows (com Chromium integrado):**
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

> 💡 **Nota sobre Navegador e Armazenamento Externo:**
> - O Playwright utiliza automaticamente o Chromium embutido em `resources/browsers/` quando empacotado.
> - As pastas `dados_json/` e `pdfs/` são **sempre externas ao `.exe`** (ficam na mesma pasta do executável ou diretório de execução). Você pode abrir, copiar ou adicionar arquivos manualmente sem afetar o executável.
> - As pastas `dados_json/` e `pdfs/` e os arquivos `auth.json` e `egressos.pbix` são **sempre externos ao `.exe`** (ficam na mesma pasta do executável ou diretório de execução). Você pode substituir o modelo `.pbix` ou inspecionar os arquivos gerados livremente.

---

## 📂 Estrutura do Projeto

```
├── auth.js               # Script para autenticação interativa e geração do auth.json
├── script.js             # Motor de scraping com Playwright e parsing de PDFs
├── server.js             # Servidor Express com API REST e streaming SSE
├── alumniHandler.js      # Gerenciador da base consolidada de alunos, merge de planilhas e exportação CSV
├── script.js             # Motor de scraping com Playwright, controle de headless/pausa e parsing de PDFs
├── server.js             # Servidor Express com API REST, streaming SSE e rotas da base de alunos
├── paths.js              # Centralizador de caminhos externos e browsers embutidos
├── main.js               # Processo principal do Electron (janela nativa)
├── Iniciar-App.vbs        # Inicializador silencioso sem janela de terminal (Windows)
├── Iniciar.bat           # Inicializador em lote com logs de terminal (Windows)
├── iniciar.sh            # Inicializador para sistemas Linux / macOS
├── pbixHandler.js        # Consolidador semântico de dados e exportador CSV
├── pbixDecoder.js        # Decodificador VertiPaq / XPress9 (WASM) para arquivos .pbix
├── pbixHandler.js        # Utilitários e rotas mantidas para suporte futuro a modelos Power BI
├── pbixDecoder.js        # Decodificador VertiPaq / XPress9 para arquivos .pbix
├── package.json          # Dependências e scripts de execução multiplataforma
├── egressos.pbix         # Arquivo do modelo Power BI integrado
├── egressos.pbix         # Arquivo do modelo Power BI integrado (externo ao .exe)
├── Alunos de ADM...xlsx  # Planilha de alunos de Administração com Matrícula e Data de Nascimento
├── lista geral...xlsx    # Planilha consolidada com nomes e links de perfis do LinkedIn
├── auth.json             # Sessão autenticada do LinkedIn (externo ao .exe)
├── dist/                 # Executáveis e pacotes pré-compilados para distribuição
├── browsers/             # Binários locais do Chromium para empacotamento
├── local_api/
│   ├── bairros_brasil.json   # Base geográfica para validação de Região (Cidade)
│   ├── lista_cargos.json     # 2.871 cargos regulamentados no Brasil
│   ├── areas.json            # 42 áreas de atuação econômica padronizadas
│   └── cargos_por_area.json  # Base unificada relacionando cargos e áreas
├── public/               # Interface Web (HTML, CSS, JS)
├── dados_json/           # Arquivos JSON extraídos dos currículos (externo ao .exe)
└── pdfs/                 # PDFs originais baixados do LinkedIn (externo ao .exe)
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

