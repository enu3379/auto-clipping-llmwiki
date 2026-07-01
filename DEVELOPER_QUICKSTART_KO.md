# Developer Quickstart (KO)

이 문서는 GitHub와 터미널 사용에 익숙한 개발자가 Auto-Clipping LLM Wiki를 받아서
desktop app, Chrome clipper extension, search API/CLI, MCP 흐름을 로컬에서 바로 확인하는
절차를 정리한다.

## 1. 준비물

- macOS 권장. Tauri 앱과 Chrome extension은 macOS에서 검증했다.
- Node.js 20+
- Rust stable toolchain
- Chrome 또는 Chromium 계열 브라우저
- Obsidian vault로 쓸 로컬 폴더
- LLM provider API key
- 검색 API를 쓸 경우 Tavily, SerpApi, Brave 등 원하는 provider key

## 2. 코드 받기

`main` 브랜치 기준으로 받으면 된다.

```bash
git clone https://github.com/enu3379/auto-clipping-llmwiki.git
cd auto-clipping-llmwiki
npm install
```

원본 프로젝트와 비교가 필요하면 upstream도 추가한다.

```bash
git remote add upstream https://github.com/nashsu/llm_wiki.git
git fetch upstream
```

## 3. Desktop App 실행

개발 모드:

```bash
npm run tauri dev
```

프로덕션 앱 번들:

```bash
npm run tauri build
```

빌드 산출물은 보통 아래에 생긴다.

```text
src-tauri/target/release/bundle/macos/LLM Wiki.app
```

앱을 실행한 뒤 Obsidian vault 또는 테스트용 폴더를 프로젝트로 연다. clipper extension은 앱이
띄우는 local clip server에 붙으므로, 클립하려면 desktop app이 실행 중이어야 한다.

상태 확인:

```bash
curl -s http://127.0.0.1:19827/status
curl -s http://127.0.0.1:19828/api/v1/health
```

정상 예시:

```json
{"ok":true,"version":"0.1.0"}
```

## 4. 앱 설정

앱 Settings에서 최소한 아래를 설정한다.

- LLM provider, model, API key
- Output language: 한국어 설명 + 영어 기술어를 원하면 `KoreanTechnicalEnglish`
- Source Watch: enabled + auto ingest enabled
- Local API: enabled
- MCP를 쓸 경우 MCP enabled
- Search API를 쓸 경우 Web Search provider와 API key

Billing AI 같은 OpenAI-compatible endpoint를 쓰는 경우 `customEndpoint`, `model`, `apiMode`를
앱에서 설정한다. 현재 Billing AI 계열 모델은 explicit `temperature`를 거절할 수 있어, 앱은
Billing AI endpoint에 대해 unsupported sampling parameter를 제거한다.

## 5. Chrome Extension 로드

1. Chrome에서 `chrome://extensions`를 연다.
2. Developer mode를 켠다.
3. "Load unpacked"를 누른다.
4. repo의 `extension/` 폴더를 선택한다.
5. 확장 팝업에서 LLM Wiki 연결 상태를 확인한다.
6. 프로젝트를 선택하고 whitelist, blacklist, dwell time, session tag를 설정한다.

확장 버전은 `extension/manifest.json`의 `version`을 확인한다. 현재 extension은 unpacked developer
extension으로 사용하는 흐름이다.

## 6. Browser Clipping Smoke Test

1. LLM Wiki desktop app을 실행한다.
2. 프로젝트가 열린 상태인지 확인한다.
3. Chrome extension popup에서 현재 사이트를 allow한다.
4. 테스트 페이지에 들어가 수동 Clip 또는 dwell auto clip을 실행한다.
5. vault에 raw source가 생기는지 확인한다.

```bash
find /path/to/Vault/raw/sources -type f -mmin -10 -print
```

6. ingest queue가 처리된 뒤 wiki output이 생기는지 확인한다.

```bash
find /path/to/Vault/wiki -type f -mmin -20 -print
cat /path/to/Vault/.llm-wiki/ingest-queue.json
```

## 7. Search API / CLI 사용

Local API는 desktop app이 실행 중일 때 동작한다. CLI는 같은 API를 호출한다.

```bash
src-tauri/target/release/llm-wiki web-search \
  --query "mixture of experts routing capacity factor" \
  --provider tavily \
  --max-results 5 \
  --out .llm-wiki/runs/web-search/moe.json
```

선택 결과를 클립한다.

```bash
src-tauri/target/release/llm-wiki clip-search \
  --run-file .llm-wiki/runs/web-search/moe.json \
  --indexes 1,2
```

클립 결과는 먼저 `raw/sources/search/YYYY-MM-DD/` 아래에 Markdown으로 저장된다. 이후 desktop
ingest worker가 Source Watch 또는 source-ingest request를 통해 wiki pages를 만든다.

## 8. MCP 사용

MCP server를 빌드한다.

```bash
npm --prefix mcp-server ci
npm run mcp:build
```

Codex, Claude Code 같은 MCP client에는 `mcp-server/dist/index.js`를 등록한다. Local API 인증이
켜져 있으면 앱 Settings의 Local API token 또는 `LLM_WIKI_API_TOKEN`을 MCP process environment에
넣어야 한다.

권장 사용 패턴:

- MCP: search 실행, clip 요청, 결과 파일 경로 반환 같은 control plane
- CLI/run file: 큰 검색 결과 JSON과 clip 결과 저장
- Desktop app: raw source ingest와 wiki page generation

## 9. 흔한 문제

### Extension에 "app not working"이 뜬다

desktop app이 실행 중인지 확인한다.

```bash
curl -s http://127.0.0.1:19827/status
```

응답이 없으면 앱을 실행하거나 `npm run tauri dev`를 켠다.

### raw source만 생기고 wiki가 안 생긴다

다음을 확인한다.

- 프로젝트가 앱에서 active 상태인지
- Source Watch가 enabled인지
- auto ingest가 enabled인지
- LLM provider 설정이 usable한지
- Activity panel에서 queue가 paused 상태인지

큐 파일:

```bash
cat /path/to/Vault/.llm-wiki/ingest-queue.json
```

### HTTP 400 invalid_request_error가 난다

대부분 provider가 특정 request parameter를 거절하는 문제다. 최신 `main`에는 Billing AI endpoint가
explicit `temperature`를 거절하는 케이스에 대한 adapter fix가 들어 있다. 오래된 앱 번들을 쓰고
있다면 최신 코드로 다시 빌드해서 앱을 교체한다.

### 검색은 되는데 clip ingest가 안 돈다

`clip-search`는 raw source를 먼저 쓰고, wiki generation은 desktop app의 ingest worker가 비동기로
처리한다. 앱이 열려 있고 해당 프로젝트가 active여야 한다.

## 10. 개발 검증 명령

주요 테스트:

```bash
npm run typecheck
npm run mcp:test
cargo test --manifest-path src-tauri/Cargo.toml --lib web_search
cargo test --manifest-path src-tauri/Cargo.toml --lib api_server
```

Billing AI adapter만 빠르게 확인:

```bash
npx vitest run src/lib/llm-providers.test.ts -t "Billing AI"
```

전체 프로덕션 빌드:

```bash
npm run tauri build
```
