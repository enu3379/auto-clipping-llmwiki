# Auto-Clipping LLM Wiki

<p align="center">
  <img src="logo.jpg" width="128" height="128" style="border-radius: 22%;" alt="LLM Wiki Logo">
</p>

<p align="center">
  <strong>스스로 자라는 개인 지식베이스 — 이제 <em>수집</em>까지 자동으로.</strong><br>
  <a href="https://github.com/nashsu/llm_wiki">nashsu/llm_wiki</a>를 포크해, 웹 클리핑을
  <b>조건 기반 자동 클리핑</b>과 <b>검색 API 기반 클리핑</b>으로 확장한다.
</p>

<p align="center">
  <a href="#이-프로젝트는">이 프로젝트는</a> •
  <a href="#이-포크가-하려는-일-로드맵">로드맵</a> •
  <a href="#개발-규칙">개발 규칙</a> •
  <a href="#프로젝트-구조">구조</a> •
  <a href="#개발-실행">개발/실행</a> •
  <a href="#크레딧">크레딧</a>
</p>

---

## 이 프로젝트는

**베이스 (`nashsu/llm_wiki`)** — 문서를 넣으면 LLM이 읽고 구조화된 위키를 스스로 만들고 유지하는
크로스플랫폼 데스크톱 앱(Tauri). 2단계 인제스트, 지식 그래프, 딥 리서치, 크롬 웹 클리퍼,
로컬 HTTP API + MCP 서버를 갖춘다. (원본 기능 상세는 [upstream README](https://github.com/nashsu/llm_wiki) 참고.)

**이 포크가 더하는 것** — 베이스의 클립 흐름은 *사용자가 버튼을 눌러야* 동작한다. 여기서는 그
**트리거를 자동화**하고, 나아가 **검색 API로 찾은 결과를 곧장 위키로 클립**한다. 앱 본체(Rust/Tauri)의
추출·변환·인제스트·중복제거(SHA256 캐시)는 그대로 재사용한다.

1. **자동 클리핑 크롬 확장** — 화이트리스트/블랙리스트, 체류시간(dwell) 기반 자동 클립,
   세션 태그, 재방문 중복 스킵, AI 출처 기반 자동클립/추천. (`extension/`)
2. **검색 API 클리핑** — Tavily·SerpApi·SearXNG·Ollama·Brave·Firecrawl로 검색해
   결과를 위키 프로젝트에 직접 클립하는 로컬 API 엔드포인트. (`src-tauri/src/web_search/`)

> 상세 설계는 [`plans/auto-clipping-automation.md`](plans/auto-clipping-automation.md) 참고.

---

## 이 포크가 하려는 일 (로드맵)

### 1) 자동 클리핑 확장 (`extension/`)

"바꾸는 건 맨 앞의 트리거 하나뿐" — 추출/전송/인제스트는 베이스를 그대로 쓰고, **언제 클립할지**만
Manifest V3 3-컴포넌트(Popup / Service Worker / Content Script)로 판정한다.

| # | 기능 | 한 줄 요약 | 상태 |
|---|------|-----------|:----:|
| F1 | 화이트리스트 자동 클립 | 등록 사이트 진입 시 짧은 dwell 후 자동 클립 | ✅ |
| F2 | dwell 자동 클립 | 토글 ON 후 **실제로 보이는** 시간이 임계(기본 30초) 넘으면 클립 | ✅ |
| F3 | 세션 태그 | 세션 태그를 마크다운 frontmatter로 심어 모든 클립에 부착 | ✅ |
| F4 | 블랙리스트 + 클립불가 스킵 | 금지 도메인 + 본문 길이 미달 페이지 건너뜀 | ✅ |
| F5 | 재방문 중복 스킵 | URL 정규화 후 클립 이력과 대조해 중복 스킵 | ✅ |
| F6 | AI 출처 기반 자동클립/추천 | AI 채팅에서 넘어온 페이지를 후보로 승격 (recommend 기본) | ✅ |

판정 파이프라인은 하나로 이어진다: `토글 → scheme → F5 중복 → F1 화이트리스트/F6 AI출처 →
F4 블랙리스트·본문길이 → 추출 → F3 태그 → POST → F5 이력 기록`.

### 2) 검색 API / CLI 클리핑 (`src-tauri/src/web_search/`, `src-tauri/src/cli.rs`)

프로바이더: **Tavily · SerpApi · SearXNG · Ollama · Brave · Firecrawl.**
로컬 API, CLI, MCP run-file 흐름으로 노출한다.

| Method | Path | 하는 일 |
|--------|------|--------|
| `POST` | `/api/v1/projects/{id}/web-search` | 프로바이더로 웹 검색, 정규화된 결과 반환 |
| `POST` | `/api/v1/projects/{id}/web-search/clip` | 검색 결과를 선택 추출해 위키에 클립(+선택적 인제스트 큐 적재) |

CLI는 같은 local API를 호출하고, 큰 검색 결과는 JSON run 파일에 저장한 뒤 짧은 요약만 stdout에 출력한다.

```bash
llm-wiki web-search --query "rust tauri local api" --out .llm-wiki/runs/web-search/rust.json
llm-wiki clip-search --run-file .llm-wiki/runs/web-search/rust.json --indexes 1,3
```

MCP 도구도 이 방향에 맞춰 `llm_wiki_web_search`는 run 파일 경로 + 인덱스 요약을 반환하고,
`llm_wiki_clip_search_results`는 `run_file` + `indexes`를 받아 클립한다. 대형 result JSON을
MCP 토큰으로 다시 주고받는 흐름은 호환 옵션으로만 남긴다.

---

## 개발 규칙

이 포크의 작업은 아래 규칙을 따른다. **새 코드/문서를 만들기 전에 이 절을 먼저 읽는다.**

### 코드 작성 규칙

무언가를 새로 짜기 전에 이 체크리스트를 순서대로 통과시킨다. 앞 단계에서 걸리면 거기서 멈춘다.

```
1. Does this need to exist?   → no: skip it (YAGNI)
2. Already in this codebase?  → reuse it, don't rewrite
3. Stdlib does it?            → use it
4. Native platform feature?   → use it
5. Installed dependency?      → use it
6. One line?                  → one line
7. Only then: the minimum that works
```

- **간결하게** — 하나의 변경/파일은 되도록 1000자를 넘지 않게. 넘으면 쪼갤 수 있는지 먼저 본다.
- **꼭 필요한 기능만** — "있으면 좋은" 것은 만들지 않는다(YAGNI).
- **라이브러리 우선** — 이미 설치된 의존성·표준 라이브러리·플랫폼 기능으로 되는 일은 직접 짜지 않는다.
- **주변 코드에 맞춘다** — 네이밍·주석 밀도·관용구를 이웃 코드와 일치시킨다.
- **앱 본체 최소 변경** — 확장 기능은 트리거만 바꾸고 추출/인제스트/중복제거는 재사용한다.

### Git 커밋 / 푸쉬 규칙

- **Conventional Commits** — `feat:`, `fix:`, `perf:`, `ci:`, `release:`. 제목은 명령형·현재형·간결하게.
  예) `feat: add whitelist and blacklist controls`
- **작업 브랜치에서** 작업한다(`main`에 직접 커밋하지 않음). 기능별 브랜치를 판다.
- **`upstream`은 읽기 전용** — `nashsu/llm_wiki`는 참조/리베이스 소스일 뿐, 절대 push하지 않는다
  (푸쉬는 `origin`으로만).
- **커밋/푸쉬는 요청/의도가 있을 때만** — 시키지 않은 커밋·푸쉬를 임의로 하지 않는다.

### 문서화 규칙

- **plan 먼저** — 규모 있는 기능은 `plans/<기능>.md`에 목표·아키텍처·데이터모델·단계(M0…)·
  테스트 체크리스트를 먼저 적고 시작한다. (예: [`plans/auto-clipping-automation.md`](plans/auto-clipping-automation.md))
- **todolist / 체크리스트로 추적** — 기능은 독립 테스트 가능한 단계로 쪼개고 `- [ ]`로 관리,
  끝나면 `- [x]`로 갱신한다.
- **문서와 코드를 함께 갱신** — 실제 소스와 계획이 어긋나면 계획 문서를 먼저 고친다("문서화된
  인터페이스 기준"으로 시작하되 코딩 전 실제 소스로 검증).
- **이 README를 최신으로** — 로드맵 상태 표(✅/🚧)는 진행에 맞춰 갱신한다.

---

## 프로젝트 구조

```
llm_wiki/
├── extension/                      # 자동 클리핑 크롬 확장 (MV3) ← 포크 핵심 1
│   ├── manifest.json               # 권한: webNavigation, tabs, storage, scripting …
│   ├── background.js               # Service Worker — 게이트 판정 + 전송
│   ├── content-script.js           # 가시 dwell 측정 + 추출
│   ├── clipper.js                  # 설정/정규화/매칭 유틸 (DEFAULT_SETTINGS)
│   ├── popup.html / popup.js       # 토글·세션태그·사이트 허용/차단 UI
│   ├── options.html / options.js   # 화이트/블랙리스트·dwell·AI출처 설정
│   └── Readability.js / Turndown.js
├── src-tauri/src/
│   ├── web_search.rs               # 검색 API 클리핑 (6 프로바이더) ← 포크 핵심 2
│   ├── web_search/                 # clips.rs / providers.rs / tests.rs
│   ├── cli.rs                      # web-search / clip-search CLI
│   └── api_server/                 # knowledge.rs 등 — web-search[/clip] 엔드포인트
├── src/                            # React 19 + TS 프론트엔드 (베이스)
├── mcp-server/                     # 로컬 MCP 서버 (베이스)
├── plans/                          # 설계/계획 문서 (plan-먼저 규칙)
└── tools/extension-smoke/          # 확장 스모크 테스트
```

---

## 개발 / 실행

```bash
# 사전 준비: Node.js 20+, Rust 1.70+
git clone https://github.com/enu3379/auto-clipping-llmwiki.git
cd auto-clipping-llmwiki
npm install
npm run tauri dev      # 개발
npm run tauri build    # 프로덕션 빌드
```

**크롬 확장 로드**

1. `chrome://extensions` 열기 → "개발자 모드" 켜기
2. "압축해제된 확장 프로그램을 로드합니다" → `extension/` 폴더 선택
3. 팝업에서 프로젝트 선택 → 자동클립 토글·화이트/블랙리스트·세션 태그 설정

**빠른 확인 흐름**: 앱 실행 → 프로젝트 생성 → Settings에서 LLM(및 필요 시 Web Search) 설정 →
확장에서 사이트 Allow → 해당 사이트 진입 시 자동 클립되어 위키에 인제스트되는지 확인.

---

## 크레딧

- **패턴** — Andrej Karpathy의 [llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  (LLM으로 개인 위키를 점진적으로 만들고 유지하는 설계 패턴)
- **베이스 앱** — [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) — 이 포크는 여기서 갈라져 나왔다.
- **이 포크** — [enu3379/auto-clipping-llmwiki](https://github.com/enu3379/auto-clipping-llmwiki) —
  자동 클리핑 확장 + 검색 API 클리핑.

## 라이선스

**GNU General Public License v3.0** — [LICENSE](LICENSE) 참고. (upstream과 동일)
