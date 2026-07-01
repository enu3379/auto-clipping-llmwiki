use super::clips::{
    render_search_clip_markdown, search_clip_filename, slugify, snippet_body, unique_markdown_path,
    yaml_string, ClipExtraction,
};
use super::providers::{
    normalize_brave_results, normalize_firecrawl_results, normalize_searxng_results,
    normalize_serpapi_results, normalize_tavily_results,
};
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(name: &str) -> PathBuf {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("llm-wiki-web-search-{name}-{id}"));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn resolves_provider_config_from_app_state_overrides() {
    let state = json!({
        "searchApiConfig": {
            "provider": "tavily",
            "apiKey": "legacy-key",
            "providerConfigs": {
                "serpapi": { "apiKey": "serp-key", "serpApiEngine": "google_news" },
                "searxng": { "searXngUrl": "search.local", "searXngCategories": ["science"] }
            }
        }
    });

    let config = resolve_search_config(Some(&state), Some("serpapi")).unwrap();
    assert_eq!(config.provider.as_str(), "serpapi");
    assert_eq!(config.api_key, "serp-key");
    assert_eq!(config.serp_api_engine, "google_news");

    let searxng = resolve_search_config(Some(&state), Some("searxng")).unwrap();
    assert_eq!(searxng.searxng_url, "search.local");
    assert_eq!(searxng.searxng_categories, vec!["science"]);
}

#[test]
fn missing_provider_config_returns_config_error() {
    let state = json!({ "searchApiConfig": { "provider": "none" } });
    let err = resolve_search_config(Some(&state), None).unwrap_err();
    assert_eq!(err.status_code(), 422);
    assert!(err.message().contains("Web search not configured"));
}

#[test]
fn filename_uses_host_title_slug_and_timestamp() {
    let filename = search_clip_filename(
        "https://www.Example.com/path?a=1",
        "A Rust & Search: Gateway!",
        "20260701T010203",
    );
    assert_eq!(
        filename,
        "example.com-a-rust-search-gateway-20260701T010203.md"
    );
}

#[test]
fn slugify_uses_fallback_for_non_ascii_titles() {
    assert_eq!(slugify("검색 결과", "untitled", 20), "untitled");
    assert_eq!(slugify("A---B", "untitled", 20), "a-b");
}

#[test]
fn yaml_string_escapes_quotes_and_newlines() {
    assert_eq!(
        yaml_string("A \"quote\"\nnext"),
        "\"A \\\"quote\\\"\\nnext\""
    );
}

#[test]
fn unique_markdown_path_adds_duplicate_suffix() {
    let dir = temp_dir("dupes");
    fs::write(dir.join("example.md"), "one").unwrap();
    fs::write(dir.join("example-2.md"), "two").unwrap();
    let path = unique_markdown_path(&dir, "example.md").unwrap();
    assert_eq!(
        path.file_name().and_then(|s| s.to_str()),
        Some("example-3.md")
    );
    let _ = fs::remove_dir_all(dir);
}

#[tokio::test]
async fn clip_search_results_writes_snippet_source_when_extraction_fails() {
    let project = temp_dir("clip-write");
    let result = WebSearchResult {
        title: "Result Title".to_string(),
        url: "not-a-url".to_string(),
        snippet: "Snippet fallback".to_string(),
        source: "example.com".to_string(),
        provider: "tavily".to_string(),
        rank: 2,
        score: None,
        query: Some("rust search".to_string()),
        searched_at: Some("2026-07-01T00:00:00Z".to_string()),
        markdown: None,
        content: None,
    };

    let response = clip_search_results(
        project.to_str().unwrap(),
        ClipSearchRequest {
            query: "rust search".to_string(),
            run_id: Some("run-1".to_string()),
            results: vec![result],
            extract: ClipExtractMode::Selected,
            whitelist: Vec::new(),
            blacklist: Vec::new(),
            allow_private_hosts: Some(true),
            actor: Some("codex".to_string()),
            origin: Some(json!({ "type": "cli-log" })),
            origin_log: None,
            enqueue: false,
        },
    )
    .await
    .unwrap();

    assert_eq!(response.written.len(), 1);
    let written = &response.written[0];
    assert!(written.path.starts_with("raw/sources/search/"));
    assert_eq!(written.extraction_status, "failed");
    let content = fs::read_to_string(project.join(&written.path)).unwrap();
    assert!(content.contains("origin: web-search"));
    assert!(content.contains("search_run_id: \"run-1\""));
    assert!(content.contains("extraction_status: \"failed\""));
    assert!(content.contains("Snippet fallback"));
    let _ = fs::remove_dir_all(project);
}

#[test]
fn normalizes_provider_responses() {
    let tavily = normalize_tavily_results(
        &json!({ "results": [{ "title": "T", "url": "https://example.com/a", "content": "Snippet", "score": 0.8 }] }),
        10,
    );
    assert_eq!(tavily[0].source, "example.com");
    assert_eq!(tavily[0].score, Some(0.8));

    let serpapi = normalize_serpapi_results(
        &json!({ "organic_results": [{ "title": "S", "link": "https://serp.dev", "snippet": "Hit" }] }),
        10,
    );
    assert_eq!(serpapi[0].url, "https://serp.dev");

    let searxng = normalize_searxng_results(
        &json!({ "results": [{ "title": "X", "url": "https://searx.test", "content": "Hit", "score": 1.2 }] }),
        10,
    );
    assert_eq!(searxng[0].score, Some(1.2));

    let brave = normalize_brave_results(
        &json!({ "web": { "results": [{ "title": "B", "url": "https://brave.test", "description": "Hit" }] } }),
        10,
    );
    assert_eq!(brave[0].snippet, "Hit");

    let firecrawl = normalize_firecrawl_results(
        &json!({ "data": [{ "title": "F", "url": "https://fire.test", "markdown": "# Full", "metadata": { "description": "Meta" } }] }),
        10,
    );
    assert_eq!(firecrawl[0].markdown.as_deref(), Some("# Full"));
}

#[test]
fn render_frontmatter_contains_required_provenance() {
    let result = WebSearchResult {
        title: "Title".to_string(),
        url: "https://example.com".to_string(),
        snippet: "Snippet".to_string(),
        source: "example.com".to_string(),
        provider: "tavily".to_string(),
        rank: 1,
        score: None,
        query: Some("rust search".to_string()),
        searched_at: Some("2026-07-01T01:02:03+09:00".to_string()),
        markdown: None,
        content: None,
    };
    let markdown = render_search_clip_markdown(
        &result,
        "rust search",
        Some("run-1"),
        1,
        "2026-07-01T01:03:03+09:00",
        "codex",
        Some(&json!({ "tool": "codex" })),
        &ClipExtraction {
            status: "failed".to_string(),
            content: snippet_body(&result),
            error: Some("boom".to_string()),
        },
    );
    assert!(markdown.contains("type: clip"));
    assert!(markdown.contains("origin: web-search"));
    assert!(markdown.contains("search_run_id: \"run-1\""));
    assert!(markdown.contains("tags: [web-search]"));
    assert!(markdown.contains("origin_log: {\"tool\":\"codex\"}"));
    assert!(markdown.contains("extraction_status: \"failed\""));
}

#[test]
fn clip_policy_matches_domain_glob_and_private_urls() {
    let state = json!({
        "searchApiConfig": {
            "clipPolicy": {
                "whitelist": ["*.example.com", "docs.*/guide/*"],
                "blacklist": ["bank.com", "*.secret.test"],
                "allowPrivateHosts": false
            }
        }
    });
    let request = ClipSearchRequest {
        query: "policy".to_string(),
        run_id: None,
        results: Vec::new(),
        extract: ClipExtractMode::None,
        whitelist: vec!["allowed.dev".to_string()],
        blacklist: vec!["tracker.example.com/path/*".to_string()],
        allow_private_hosts: None,
        actor: None,
        origin: None,
        origin_log: None,
        enqueue: false,
    };
    let policy = resolve_clip_url_policy(Some(&state), &request);

    assert!(policy
        .skip_reason("https://news.bank.com/report")
        .unwrap()
        .contains("blacklist"));
    assert!(policy
        .skip_reason("https://tracker.example.com/path/a")
        .unwrap()
        .contains("blacklist"));
    assert!(policy
        .skip_reason("http://127.0.0.1/article")
        .unwrap()
        .contains("private"));
    assert!(policy
        .skip_reason("https://sub.example.com/article")
        .is_none());
    assert!(policy
        .skip_reason("https://docs.anything/guide/start")
        .is_none());
    assert!(policy.skip_reason("https://allowed.dev/a").is_none());
    assert!(policy
        .skip_reason("https://unlisted.dev/a")
        .unwrap()
        .contains("whitelist"));
}

#[tokio::test]
async fn clip_search_results_skips_blacklisted_urls() {
    let project = temp_dir("clip-policy");
    let blocked = WebSearchResult {
        title: "Blocked".to_string(),
        url: "https://secret.example.com/private".to_string(),
        snippet: "Should not be written".to_string(),
        source: "secret.example.com".to_string(),
        provider: "tavily".to_string(),
        rank: 1,
        score: None,
        query: None,
        searched_at: None,
        markdown: Some("# Secret".to_string()),
        content: None,
    };
    let allowed = WebSearchResult {
        title: "Allowed".to_string(),
        url: "https://public.example.com/article".to_string(),
        snippet: "Allowed snippet".to_string(),
        source: "public.example.com".to_string(),
        provider: "tavily".to_string(),
        rank: 2,
        score: None,
        query: None,
        searched_at: None,
        markdown: None,
        content: None,
    };

    let response = clip_search_results(
        project.to_str().unwrap(),
        ClipSearchRequest {
            query: "policy".to_string(),
            run_id: None,
            results: vec![blocked, allowed],
            extract: ClipExtractMode::None,
            whitelist: Vec::new(),
            blacklist: vec!["secret.example.com".to_string()],
            allow_private_hosts: None,
            actor: None,
            origin: None,
            origin_log: None,
            enqueue: false,
        },
    )
    .await
    .unwrap();

    assert_eq!(response.written.len(), 1);
    assert_eq!(response.skipped.len(), 1);
    assert_eq!(
        response.skipped[0].url,
        "https://secret.example.com/private"
    );
    assert!(response.skipped[0].reason.contains("blacklist"));
    let content = fs::read_to_string(project.join(&response.written[0].path)).unwrap();
    assert!(content.contains("Allowed snippet"));
    assert!(!content.contains("Secret"));
    let _ = fs::remove_dir_all(project);
}
