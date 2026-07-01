use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{Local, SecondsFormat};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

mod clips;
mod providers;

#[cfg(test)]
mod tests;

pub use clips::{clip_search_results, clip_search_results_with_policy};

const DEFAULT_MAX_RESULTS: usize = 10;
const HARD_MAX_RESULTS: usize = 50;
const MAX_QUERIES: usize = 10;
const SEARCH_TIMEOUT_SECS: u64 = 25;
const EXTRACT_TIMEOUT_SECS: u64 = 35;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub rank: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(
        default,
        alias = "searched_at",
        skip_serializing_if = "Option::is_none"
    )]
    pub searched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchRequest {
    pub queries: Vec<String>,
    pub provider: Option<String>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResponse {
    pub ok: bool,
    pub project_id: String,
    pub run_id: String,
    pub provider: String,
    pub results: Vec<WebSearchResult>,
    pub errors: Vec<WebSearchErrorItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchErrorItem {
    pub query: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClipExtractMode {
    None,
    Selected,
}

fn default_extract_mode() -> ClipExtractMode {
    ClipExtractMode::Selected
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSearchRequest {
    pub query: String,
    pub run_id: Option<String>,
    pub results: Vec<WebSearchResult>,
    #[serde(default = "default_extract_mode")]
    pub extract: ClipExtractMode,
    #[serde(default, alias = "allowlist")]
    pub whitelist: Vec<String>,
    #[serde(default, alias = "blocklist")]
    pub blacklist: Vec<String>,
    #[serde(default, alias = "allowPrivateUrls")]
    pub allow_private_hosts: Option<bool>,
    pub actor: Option<String>,
    pub origin: Option<Value>,
    #[serde(default, alias = "originLog")]
    pub origin_log: Option<Value>,
    #[serde(default = "default_true")]
    pub enqueue: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSearchResponse {
    pub written: Vec<WrittenClip>,
    pub skipped: Vec<SkippedClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenClip {
    pub path: String,
    pub title: String,
    pub url: String,
    pub provider: String,
    pub rank: usize,
    pub extraction_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedClip {
    pub title: String,
    pub url: String,
    pub provider: String,
    pub rank: usize,
    pub reason: String,
}

#[derive(Debug, Clone, Default)]
pub struct ClipUrlPolicy {
    whitelist: Vec<String>,
    blacklist: Vec<String>,
    allow_private_hosts: bool,
}

#[derive(Debug, Clone)]
pub enum WebSearchError {
    Config(String),
    Request(String),
}

impl WebSearchError {
    pub fn message(&self) -> &str {
        match self {
            WebSearchError::Config(message) | WebSearchError::Request(message) => message,
        }
    }

    pub fn status_code(&self) -> u16 {
        match self {
            WebSearchError::Config(_) => 422,
            WebSearchError::Request(_) => 502,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SearchProvider {
    Tavily,
    SerpApi,
    SearXng,
    Ollama,
    Brave,
    Firecrawl,
}

impl SearchProvider {
    fn parse(value: &str) -> Result<Self, WebSearchError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "tavily" => Ok(Self::Tavily),
            "serpapi" => Ok(Self::SerpApi),
            "searxng" => Ok(Self::SearXng),
            "ollama" => Ok(Self::Ollama),
            "brave" => Ok(Self::Brave),
            "firecrawl" => Ok(Self::Firecrawl),
            "none" | "" => Err(WebSearchError::Config(
                "Web search not configured. Select a search provider in Settings.".to_string(),
            )),
            other => Err(WebSearchError::Config(format!(
                "Unknown search provider: {other}"
            ))),
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Tavily => "tavily",
            Self::SerpApi => "serpapi",
            Self::SearXng => "searxng",
            Self::Ollama => "ollama",
            Self::Brave => "brave",
            Self::Firecrawl => "firecrawl",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ResolvedSearchConfig {
    pub(super) provider: SearchProvider,
    pub(super) api_key: String,
    pub(super) serp_api_engine: String,
    pub(super) searxng_url: String,
    pub(super) searxng_categories: Vec<String>,
}

pub async fn web_search(
    app_state: Option<&Value>,
    project_id: String,
    request: WebSearchRequest,
) -> Result<WebSearchResponse, WebSearchError> {
    let queries = normalize_queries(request.queries)?;
    let max_results = request
        .max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);
    let config = resolve_search_config(app_state, request.provider.as_deref())?;
    validate_provider_config(&config)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|err| WebSearchError::Request(format!("Search HTTP client error: {err}")))?;
    let run_id = Uuid::new_v4().to_string();
    let searched_at = clips::now_rfc3339();
    let mut all_results = Vec::new();
    let mut errors = Vec::new();

    for query in queries {
        match providers::search_one(&client, &config, &query, max_results).await {
            Ok(mut results) => {
                for (idx, result) in results.iter_mut().enumerate() {
                    result.provider = config.provider.as_str().to_string();
                    result.rank = idx + 1;
                    result.query = Some(query.clone());
                    result.searched_at = Some(searched_at.clone());
                }
                all_results.extend(results);
            }
            Err(err) => errors.push(WebSearchErrorItem {
                query,
                error: err.message().to_string(),
            }),
        }
    }

    Ok(WebSearchResponse {
        ok: true,
        project_id,
        run_id,
        provider: config.provider.as_str().to_string(),
        results: all_results,
        errors,
    })
}

fn normalize_queries(queries: Vec<String>) -> Result<Vec<String>, WebSearchError> {
    let queries = queries
        .into_iter()
        .map(|query| query.trim().to_string())
        .filter(|query| !query.is_empty())
        .collect::<Vec<_>>();
    if queries.is_empty() {
        return Err(WebSearchError::Config(
            "queries must contain at least one non-empty query".to_string(),
        ));
    }
    if queries.len() > MAX_QUERIES {
        return Err(WebSearchError::Config(format!(
            "queries may contain at most {MAX_QUERIES} entries"
        )));
    }
    Ok(queries)
}

fn validate_provider_config(config: &ResolvedSearchConfig) -> Result<(), WebSearchError> {
    match config.provider {
        SearchProvider::Tavily | SearchProvider::SerpApi | SearchProvider::Brave
            if config.api_key.trim().is_empty() =>
        {
            Err(WebSearchError::Config(
                "Web search not configured. Add a Tavily, SerpApi, or Brave Search API key in Settings, or select a key-free provider such as Firecrawl or SearXNG.".to_string(),
            ))
        }
        SearchProvider::Ollama if config.api_key.trim().is_empty() => Err(WebSearchError::Config(
            "Ollama Web Search API requires an Ollama API key. Add one in Settings.".to_string(),
        )),
        SearchProvider::SearXng if config.searxng_url.trim().is_empty() => {
            Err(WebSearchError::Config(
                "Web search not configured. Add a SearXNG instance URL in Settings.".to_string(),
            ))
        }
        _ => Ok(()),
    }
}

fn resolve_search_config(
    app_state: Option<&Value>,
    provider_override: Option<&str>,
) -> Result<ResolvedSearchConfig, WebSearchError> {
    let root = app_state
        .and_then(|state| state.get("searchApiConfig"))
        .ok_or_else(|| {
            WebSearchError::Config(
                "Web search not configured. Save a search provider in Settings.".to_string(),
            )
        })?;
    let provider_name = provider_override
        .filter(|provider| !provider.trim().is_empty())
        .or_else(|| string_field(root, "provider"))
        .unwrap_or("none");
    let provider = SearchProvider::parse(provider_name)?;
    let provider_config = root
        .get("providerConfigs")
        .and_then(Value::as_object)
        .and_then(|configs| configs.get(provider.as_str()));

    let api_key = string_field(provider_config.unwrap_or(&Value::Null), "apiKey")
        .or_else(|| {
            if matches!(provider, SearchProvider::Firecrawl) {
                None
            } else {
                string_field(root, "apiKey")
            }
        })
        .unwrap_or("")
        .to_string();
    let serp_api_engine = string_field(provider_config.unwrap_or(&Value::Null), "serpApiEngine")
        .or_else(|| string_field(root, "serpApiEngine"))
        .unwrap_or("google")
        .to_string();
    let searxng_url = string_field(provider_config.unwrap_or(&Value::Null), "searXngUrl")
        .or_else(|| string_field(root, "searXngUrl"))
        .unwrap_or("")
        .to_string();
    let searxng_categories =
        string_array_field(provider_config.unwrap_or(&Value::Null), "searXngCategories")
            .or_else(|| string_array_field(root, "searXngCategories"))
            .filter(|categories| !categories.is_empty())
            .unwrap_or_else(|| vec!["general".to_string()]);

    Ok(ResolvedSearchConfig {
        provider,
        api_key,
        serp_api_engine,
        searxng_url,
        searxng_categories,
    })
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn string_array_field(value: &Value, key: &str) -> Option<Vec<String>> {
    value.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    })
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

pub fn resolve_clip_url_policy(
    app_state: Option<&Value>,
    request: &ClipSearchRequest,
) -> ClipUrlPolicy {
    let mut policy = app_state
        .and_then(clip_policy_value)
        .map(ClipUrlPolicy::from_value)
        .unwrap_or_default();

    policy
        .whitelist
        .extend(normalize_policy_list(request.whitelist.clone()));
    policy
        .blacklist
        .extend(normalize_policy_list(request.blacklist.clone()));
    if let Some(allow_private_hosts) = request.allow_private_hosts {
        policy.allow_private_hosts = allow_private_hosts;
    }
    policy
}

fn clip_policy_value(app_state: &Value) -> Option<&Value> {
    app_state
        .get("searchApiConfig")
        .and_then(|config| {
            config
                .get("clipPolicy")
                .or_else(|| config.get("webClipPolicy"))
        })
        .or_else(|| app_state.get("webSearchClipPolicy"))
}

impl ClipUrlPolicy {
    fn from_value(value: &Value) -> Self {
        let mut whitelist = Vec::new();
        for key in ["whitelist", "allowlist", "allowedDomains"] {
            if let Some(items) = string_array_field(value, key) {
                whitelist.extend(items);
            }
        }

        let mut blacklist = Vec::new();
        for key in ["blacklist", "blocklist", "blockedDomains"] {
            if let Some(items) = string_array_field(value, key) {
                blacklist.extend(items);
            }
        }

        let allow_private_hosts = bool_field(value, "allowPrivateHosts")
            .or_else(|| bool_field(value, "allowPrivateUrls"))
            .unwrap_or(false);

        Self {
            whitelist: normalize_policy_list(whitelist),
            blacklist: normalize_policy_list(blacklist),
            allow_private_hosts,
        }
    }

    pub fn from_request(request: &ClipSearchRequest) -> Self {
        resolve_clip_url_policy(None, request)
    }

    pub fn skip_reason(&self, url: &str) -> Option<String> {
        if let Some(pattern) = matching_pattern(&self.blacklist, url) {
            return Some(format!("blocked by blacklist: {pattern}"));
        }

        if !self.allow_private_hosts && is_private_or_local_url(url) {
            return Some("blocked private or local URL".to_string());
        }

        if !self.whitelist.is_empty() && matching_pattern(&self.whitelist, url).is_none() {
            return Some("not allowed by whitelist".to_string());
        }

        None
    }
}

fn normalize_policy_list(items: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for item in items {
        let item = item.trim();
        if !item.is_empty() && !normalized.iter().any(|existing: &String| existing == item) {
            normalized.push(item.to_string());
        }
    }
    normalized
}

fn matching_pattern(patterns: &[String], url: &str) -> Option<String> {
    patterns
        .iter()
        .find(|pattern| matches_clip_pattern(pattern, url))
        .cloned()
}

fn matches_clip_pattern(pattern: &str, url: &str) -> bool {
    let pattern = pattern.trim().trim_end_matches('/').to_ascii_lowercase();
    if pattern.is_empty() {
        return false;
    }

    let raw_url = url.trim().trim_end_matches('/').to_ascii_lowercase();
    let parsed = reqwest::Url::parse(url).ok();
    let host = parsed
        .as_ref()
        .and_then(|parsed| parsed.host_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let authority = parsed
        .as_ref()
        .map(|parsed| {
            parsed
                .port()
                .map(|port| format!("{host}:{port}"))
                .unwrap_or_else(|| host.clone())
        })
        .unwrap_or_default();
    let path = parsed
        .as_ref()
        .map(|parsed| parsed.path().trim_end_matches('/').to_ascii_lowercase())
        .unwrap_or_default();
    let full_without_query = parsed
        .as_ref()
        .map(|parsed| {
            format!(
                "{}://{}{}",
                parsed.scheme().to_ascii_lowercase(),
                authority,
                path
            )
            .trim_end_matches('/')
            .to_string()
        })
        .unwrap_or_else(|| raw_url.clone());
    let host_path = if authority.is_empty() {
        String::new()
    } else {
        format!("{authority}{path}")
    };

    if !pattern.contains("://") && !pattern.contains('/') && !pattern.contains('*') {
        return domain_pattern_matches(&pattern, &host, &authority);
    }
    if pattern.starts_with("*.") && !pattern.contains('/') {
        return domain_pattern_matches(pattern.trim_start_matches("*."), &host, &authority);
    }

    let matched = [&full_without_query, &host_path, &authority, &host, &raw_url]
        .into_iter()
        .filter(|candidate| !candidate.is_empty())
        .any(|candidate| wildcard_match(&pattern, candidate));
    matched
}

fn domain_pattern_matches(pattern: &str, host: &str, authority: &str) -> bool {
    let pattern = pattern.trim_start_matches("*.");
    if pattern.contains(':') {
        return authority == pattern;
    }
    host == pattern || host.ends_with(&format!(".{pattern}"))
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == value;
    }

    let starts_with_wildcard = pattern.starts_with('*');
    let ends_with_wildcard = pattern.ends_with('*');
    let parts = pattern
        .split('*')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return true;
    }

    let mut offset = 0usize;
    for (idx, part) in parts.iter().enumerate() {
        let haystack = &value[offset..];
        let Some(found) = haystack.find(part) else {
            return false;
        };
        if idx == 0 && !starts_with_wildcard && found != 0 {
            return false;
        }
        offset += found + part.len();
    }

    if !ends_with_wildcard {
        if let Some(last) = parts.last() {
            return value.ends_with(last);
        }
    }
    true
}

fn is_private_or_local_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    is_private_or_local_host(host)
}

fn is_private_or_local_host(host: &str) -> bool {
    let normalized = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
        || normalized.ends_with(".internal")
        || normalized.ends_with(".intranet")
        || normalized.ends_with(".lan")
    {
        return true;
    }

    match normalized.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        }
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_unspecified()
        }
        Err(_) => false,
    }
}
