# FreeDeepseekAPI

<p align="center">
  <strong>Proxy API local compatível com OpenAI para o DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/RC-ia/FreeDeepseekAPI/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
</p>

<p align="center">
  <a href="#-início-rápido">Início Rápido</a> •
  <a href="#-recursos">Recursos</a> •
  <a href="#-exemplos-de-requisições">Exemplos</a> •
  <a href="#-modelos">Modelos</a> •
  <a href="#-endpoints">Endpoints</a> •
  <a href="#-open-webui">Open WebUI</a>
</p>

O FreeDeepseekAPI sobe um servidor de API local para o **DeepSeek Web Chat** (`chat.deepseek.com`) e permite conectar o DeepSeek Web ao Open WebUI, LiteLLM, Hermes, Claude Code, clientes estilo OpenAI SDK e outras ferramentas compatíveis com OpenAI.

O projeto funciona através da sua conta normal do DeepSeek logada em um perfil isolado do Chrome. O servidor local recebe as requisições de API e, por baixo, acessa o DeepSeek Web usando a sessão de navegador salva.

> ⚠️ Este é um proxy experimental de web-chat. O DeepSeek pode mudar a Web API interna sem aviso. Para casos de produção, o API oficial paga do DeepSeek é mais confiável.

ForgetMeAI: https://t.me/forgetmeai

---

## 🔧 Patch de normalização de tool-call (vendorizado)

Este fork inclui um **normalizador de tool-call** vendorizado (`toolcall_normalizer.js`) que fecha uma lacuna no parser original: o DeepSeek Web emite chamadas de função nativas como XML —

```xml
<tool_call name="todo_write">
  <parameter name="todos">[{"id":"1","content":"...","status":"in_progress"}]</parameter>
</tool_call>
```

— o que o `parseToolCall()` original não conseguia parsear (ele esperava um corpo JSON). O normalizador roda como um FAST-PATH dentro do `parseToolCall()` e converte esse formato nativo (além das variantes strict-JSON / fenced-JSON / legado `TOOL_CALL:`) em um payload OpenAI `tool_calls` limpo.

- **Projeto upstream (autor original — por favor creditar):** [ForgetMeAI/FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI) por **ForgetMeAI** (`t.me/forgetmeai`), MIT.
- **Normalizador companion:** [RC-ia/deepseek-toolcall-normalizer](https://github.com/RC-ia/deepseek-toolcall-normalizer) por **RC-ia**, MIT.
- Os testes cobrem o formato XML nativo (veja `tests/unit.test.js`). Rode `npm test`.

---

## Navegação

- [O que ele oferece](#-o-que-ele-oferece)
- [Recursos](#-recursos)
- [Início Rápido](#-início-rápido)
- [Execução no Windows](#-execução-no-windows)
- [Execução no Linux / Chromium](#-execução-no-linux--chromium)
- [Execução em VPS / headless](#-execução-em-vps--headless)
- [Diagnóstico / doctor](#-diagnóstico--doctor)
- [Reuso de sessão e reset de chats](#-reuso-de-sessão-e-reset-de-chats)
- [Pool de multi-contas](#-pool-de-multi-contas)
- [Verificação de funcionamento](#-verificação-de-funcionamento)
- [Exemplos de requisições](#-exemplos-de-requisições)
  - [Chat Completions](#chat-completions)
  - [Reasoning](#reasoning)
  - [Web search](#web-search)
  - [Streaming](#streaming)
  - [Anthropic Messages API](#anthropic-messages-api)
  - [OpenAI Responses API](#openai-responses-api)
  - [Tool calling](#tool-calling)
- [Modelos](#-modelos)
- [Endpoints](#-endpoints)
- [Open WebUI](#-open-webui)
- [Atualizar login](#-atualizar-login)
- [Status do projeto](#-status-do-projeto)

---

## ✨ O que ele oferece

- Usar o DeepSeek Web como um endpoint de API local.
- Conectar o DeepSeek ao Open WebUI e outros clientes compatíveis com OpenAI.
- Receber respostas JSON normais ou streaming SSE.
- Usar modelos de reasoning com `reasoning_content` separado.
- Usar o shim de Anthropic Messages API para Claude Code / Anthropic SDK.
- Usar o shim de OpenAI Responses API para clientes estilo OpenAI/Codex.
- Manter sessões web separadas para diferentes agentes/usuários.

## 🚀 Recursos

- **API compatível com OpenAI:** `POST /v1/chat/completions`
- **Shim compatível com Anthropic:** `POST /v1/messages`
- **Shim de OpenAI Responses:** `POST /v1/responses`
- **Streaming:** chunks SSE e respostas JSON non-stream normais
- **Saída de reasoning:** `reasoning_content` separado para modelos thinking
- **Tool calling:** parsing de ferramentas OpenAI, ferramentas Anthropic e function tools do Responses
- **Capacidades de modelo:** `GET /v1/model-capabilities` com alias → modo web real
- **Sessões de agente:** uma sessão DeepSeek separada por `user` / agent id
- **Recuperação de sessão:** auto-reset de chains/sessões obsoletas
- **Zero dependências:** Node.js 18+, sem dependências npm

---

## ⚡ Início Rápido

```bash
git clone https://github.com/RC-ia/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

> ⚠️ Troque a URL acima pela do **fork** (`RC-ia/FreeDeepseekAPI`), não do repo original do ForgetMeAI.

`npm run auth` abre o menu de autorização:

1. selecione a opção `1`;
2. faça login no DeepSeek em um perfil isolado do Chrome;
3. envie uma mensagem curta como `ok`;
4. volte ao terminal e pressione Enter.

`npm start` mostra o menu de inicialização:

- `1` — autorizar / atualizar o login do DeepSeek
- `2` — mostrar modelos e status
- `3` — iniciar o proxy
- `4` — sair

Para execução headless/CI sem menu:

```bash
NON_INTERACTIVE=1 npm start
# ou
SKIP_ACCOUNT_MENU=1 npm start
```

Por padrão, o servidor escuta em:

```text
http://localhost:9655
```

---

## 🪟 Execução no Windows

```powershell
git clone https://github.com/RC-ia/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

Se o Chrome estiver em um caminho não padrão, indique explicitamente:

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

Se o Chrome não for encontrado, o `npm run auth` agora imprime instruções prontas para Windows/macOS/Linux em vez de um stack trace misterioso.

---

## 🐧 Execução no Linux / Chromium

```bash
git clone https://github.com/RC-ia/FreeDeepseekAPI.git
cd FreeDeepseekAPI
CHROME_PATH=$(which chromium) npm run auth
npm start
```

Se o Chromium tiver outro nome:

```bash
CHROME_PATH=$(which chromium-browser) npm run auth
# ou
CHROME_PATH=$(which google-chrome) npm run auth
```

---

## 🖥 Execução em VPS / headless

O fluxo mais confiável sem Chrome no servidor:

1. No PC de casa, onde há GUI/Chrome:

```bash
npm run auth
```

2. Copie o `deepseek-auth.json` para a VPS:

```bash
scp deepseek-auth.json user@seu-servidor:/opt/FreeDeepseekAPI/deepseek-auth.json
```

3. Na VPS, importe/verifique o arquivo e defina permissões seguras:

```bash
cd /opt/FreeDeepseekAPI
npm run auth:import -- --input ./deepseek-auth.json
npm run doctor -- --offline
```

4. Execute o proxy sem o menu interativo:

```bash
NON_INTERACTIVE=1 npm start
```

Também é possível importar não apenas um `deepseek-auth.json` pronto, mas também um export de cookies do navegador:

```bash
DEEPSEEK_TOKEN="<token>" npm run auth:import -- --input ./cookies.json
```

> Importante: `deepseek-auth.json` é o acesso ao seu login do DeepSeek Web. Não faça commit, não publique, guarde com permissão `0600`.

---

## 🩺 Diagnóstico / doctor

```bash
npm run doctor
# sem requisições de rede ao DeepSeek:
npm run doctor -- --offline
```

O `doctor` verifica:

- se `deepseek-auth.json` / `DEEPSEEK_AUTH_DIR` foi encontrado;
- se o JSON é válido;
- se há `token`, `cookie`, `wasmUrl`;
- se as permissões do arquivo estão seguras em macOS/Linux (`0600`);
- na execução normal — se o endpoint PoW do DeepSeek está acessível.

Se você vir `data.biz_data is null`, `fetch failed`, `401/403/429` ou o Hermes/OpenCode não vê os modelos — rode o `npm run doctor` primeiro.

---

## ♻️ Reuso de sessão e reset de chats

O FreeDeepseekAPI não cria um novo chat do DeepSeek a cada requisição HTTP sem motivo. A lógica é:

- um `x-agent-session`, `session` ou `user` → uma DeepSeek chat session;
- se o session id já existir — o proxy o reutiliza e continua a chain via `parent_message_id`;
- o auto-reset ocorre por TTL, erro de sessão do DeepSeek ou chain de mensagens muito longa;
- o histórico local é preservado em um contexto curto para que uma nova sessão DeepSeek possa continuar a conversa.

Definir agent/session explicitamente:

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Oi"}]}'
```

Ver sessões ativas:

```bash
curl http://localhost:9655/v1/sessions
```

Resetar uma sessão:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=my-agent"
```

Resetar todas as sessões:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=all"
```

Por que os chats ainda aparecem no DeepSeek Web: o proxy funciona via Web Chat API interna, e o DeepSeek guarda as sessões de chat reais do lado dele. Isso é normal para um web-proxy. O objetivo do session reuse é não criar novos chats sem necessidade e fazer o reset com cuidado apenas quando a chain estagna/quebra.

---

## 👥 Pool de multi-contas

É possível conectar vários arquivos de auth. O modelo correto: conta sticky por agent/session — o proxy não troca a conta dentro de uma sessão DeepSeek viva. Se uma conta receber `401/403/429` e entrar em cooldown, a sessão é resetada com segurança e a nova requisição pode ir para outra conta disponível.

Opção 1 — diretório com arquivos de auth:

```bash
mkdir -p accounts
cp deepseek-auth-main.json accounts/main.json
cp deepseek-auth-backup.json accounts/backup.json
chmod 600 accounts/*.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```

Opção 2 — lista de arquivos:

```bash
DEEPSEEK_AUTH_PATH="./accounts/main.json,./accounts/backup.json" NON_INTERACTIVE=1 npm start
```

Como o pool funciona:

- um novo agent/session recebe uma conta disponível em round-robin;
- a conta escolhida é fixada à sessão (`sticky`);
- em `401`, `403`, `429` a conta entra em cooldown;
- se a conta sticky da sessão entrou em cooldown, a sessão DeepSeek antiga é resetada para não martelar a conta rate-limited/expirada;
- o status das contas aparece em `/health` sem expor os caminhos ou nomes dos arquivos de auth;
- os arquivos de auth devem ser guardados com permissão `0600`.

Configurar cooldown:

```bash
DEEPSEEK_ACCOUNT_COOLDOWN_MS=600000 npm start
```

---

## 🔑 Ideias para autorização via console

O fluxo por senha do PR #3 pode ser feito, mas é mais seguro não armazenar a senha nem torná-lo o padrão. Implementação normal:

1. `npm run auth:console` pergunta email/telefone e senha via prompt oculto.
2. A senha fica apenas na memória do processo, não é escrita em arquivos/logs/history.
3. O script repete o fluxo de login Web via `fetch`/CDP: recebe o desafio de captcha/verificação, entrega o link/código para a pessoa, aguarda confirmação.
4. Após login bem-sucedido, apenas o `deepseek-auth.json` no formato padrão é salvo.
5. Se o DeepSeek pedir captcha/2FA — o script avisa honestamente "abra o link, passe na verificação, pressione Enter", em vez de tentar burlar a proteção.
6. Para VPS, o modo `auth:console --no-save-password --output deepseek-auth.json` é preferível.

MVP mínimo seguro: auth via console apenas interativo, sem senha em env. Variação aceitável de automação: `DEEPSEEK_EMAIL=... npm run auth:console`, mas a senha ainda é digitada via hidden prompt.

---

## ✅ Verificação de funcionamento

```bash
curl http://localhost:9655/
curl http://localhost:9655/v1/models
curl http://localhost:9655/v1/model-capabilities
```

Se estiver tudo ok, o `/health` retorna o status do servidor, a lista de aliases suportados e `config_ready: true`.

---

## 🧪 Exemplos de requisições

### Chat Completions

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Olá! Responda com uma frase."}],
    "stream": false
  }'
```

### Reasoning

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Responda brevemente: por que o céu é azul?"}],
    "stream": false
  }'
```

Para modelos de reasoning, a API devolve a cadeia de raciocínio separada da resposta final:

- non-stream: `choices[0].message.reasoning_content`
- stream: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` é uma estimativa aproximada baseada no texto `THINK` extraído do DeepSeek Web, pois o stream web não devolve o token usage oficial de reasoning separadamente.

### Web search

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-search",
    "messages": [{"role": "user", "content": "Encontre um fato recente sobre o DeepSeek e responda brevemente."}],
    "stream": false
  }'
```

### Streaming

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Conte uma piada curta."}],
    "stream": true
  }'
```

### Anthropic Messages API

```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Responda exatamente OK"}],
    "stream": false
  }'
```

Para usar com o Claude Code, defina o backend diretamente:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-chat
```

### OpenAI Responses API

```bash
curl -X POST http://localhost:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Responda exatamente OK",
    "stream": false
  }'
```

### Tool calling

O FreeDeepseekAPI aceita:

- `tools` do OpenAI;
- `tools` do Anthropic;
- function tools do Responses API.

O proxy pede ao DeepSeek para devolver um tool call JSON estrito, mas também sabe parsear formatos fallback:

- `TOOL_CALL:`
- fenced JSON
- `<tool_call>...</tool_call>` (incluindo o formato nativo `<tool_call name=><parameter>` do DeepSeek Web, graças ao normalizador vendorizado)

---

## 🧠 Modelos

`GET /v1/models` retorna apenas os aliases que estão verificados e funcionando através deste proxy.

### Aliases funcionais

| Alias | Web mode | Reasoning | Web search | Comentário |
| --- | --- | --- | --- | --- |
| `deepseek-chat` | `Быстрый` / `default` | não | não | chat básico |
| `deepseek-v3` | `Быстрый` / `default` | não | não | alias compatível |
| `deepseek-default` | `Быстрый` / `default` | não | não | alias compatível |
| `deepseek-reasoner` | `Быстрый` / `default` | sim | não | `thinking_enabled=true` |
| `deepseek-r1` | `Быстрый` / `default` | sim | não | alias compatível R1 |
| `deepseek-chat-search` | `Быстрый` / `default` | não | sim | web search |
| `deepseek-default-search` | `Быстрый` / `default` | não | sim | alias de web search |
| `deepseek-reasoner-search` | `Быстрый` / `default` | sim | sim | reasoning + search |
| `deepseek-r1-search` | `Быстрый` / `default` | sim | sim | R1-compatible + search |
| `deepseek-expert` | `Эксперт` / `expert` | não | não | Expert mode |
| `deepseek-v4-pro` | `Эксперт` / `expert` | sim | não | Expert + reasoning |

Mapeamento completo:

```bash
curl http://localhost:9655/v1/model-capabilities
```

Segundo a página oficial do DeepSeek V4 Preview, `deepseek-chat` e `deepseek-reasoner` atualmente roteiam para `deepseek-v4-flash` non-thinking/thinking. No próprio `chat.deepseek.com`, o stream direto não devolve o nome exato do checkpoint (`model: ""`), então o proxy registra tanto o modo web (`default` / `Быстрый`) quanto o roteamento oficial atual (`DeepSeek-V4-Flash`).

Os modos web atuais do remote config do DeepSeek Web mostram:

- `default` / UI `Быстрый` — funciona; suporta `thinking_enabled` e `search_enabled`.
- `expert` / UI `Эксперт` — funciona através do contrato web atual (`x-client-version=2.0.0`) e suporta `thinking_enabled`. Em `/v1/models` aparecem `deepseek-expert` sem reasoning e `deepseek-v4-pro` como Expert + reasoning.
- `vision` / UI `Распознавание` — visível no remote config, mas o direct Web API retorna `backend_err_by_model` (`Vision is temporarily unavailable`). Por isso `deepseek-vision` fica oculto em `/v1/models`.

O Search para o Expert não está disponível no remote config, então `deepseek-expert-search` segue como unsupported.

---

## 🔌 Endpoints

| Método | Caminho | Finalidade |
| --- | --- | --- |
| `GET` | `/` ou `/health` | status do proxy |
| `GET` | `/v1/models` | lista de aliases funcionais compatíveis com OpenAI |
| `GET` | `/v1/model-capabilities` | mapeamento completo de aliases, modelo real, capacidades |
| `POST` | `/v1/chat/completions` | Chat Completions compatível com OpenAI |
| `POST` | `/v1/messages` | shim de Anthropic Messages API |
| `POST` | `/v1/responses` | shim de OpenAI Responses API |
| `GET` | `/v1/sessions` | sessões de agente locais ativas |
| `POST` | `/reset-session?agent=<id>` | resetar uma sessão |
| `POST` | `/reset-session?agent=all` | resetar todas as sessões |

---

## 🖥 Open WebUI

Base URL para o Open WebUI no Docker:

```text
http://host.docker.internal:9655/v1
```

Para execução local sem Docker:

```text
http://localhost:9655/v1
```

A API key pode ser qualquer uma: o proxy acessa o DeepSeek Web pela sessão de navegador salva.

---

## 🔐 Atualizar login

```bash
npm run auth
npm start
```

Se o DeepSeek começar a responder `401`, `403` ou pedir um novo PoW/session — repita o `npm run auth` e atualize a sessão de navegador salva.

Os arquivos de autorização locais não devem ir para o GitHub:

- `deepseek-auth.json`
- `.chrome-profile-deepseek/`
- `.env`

Eles já estão no `.gitignore`.

---

## 🧪 Testes

Verificação de sintaxe do projeto:

```bash
npm test
```

Smoke tests live contra o proxy local em execução:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-chat npm run test:live
```

---

## 📌 Status do projeto

O FreeDeepseekAPI é um proxy de web-chat experimental para uso local e integrações. Ele depende do contrato atual do DeepSeek Web Chat, então mudanças do lado do DeepSeek podem exigir atualização da lógica de auth/session ou do mapeamento de modelos.

Se algo parar de funcionar:

1. atualize o login via `npm run auth`;
2. verifique `/v1/model-capabilities`;
3. repita a requisição em uma sessão nova;
4. se o problema persistir — provavelmente o DeepSeek mudou a Web API interna.

---

<p align="center">
  <strong>RC-ia</strong> · fork de <a href="https://github.com/ForgetMeAI/FreeDeepseekAPI">ForgetMeAI/FreeDeepseekAPI</a> · <a href="https://t.me/forgetmeai">Telegram do autor original</a>
</p>
