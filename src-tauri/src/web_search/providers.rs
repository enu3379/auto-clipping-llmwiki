use super::*;

pub(super) async fn search_one(
    client: &reqwest::Client,
    config: &ResolvedSearchConfig,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, WebSearchError> {
    match config.provider {
        SearchProvider::Tavily => tavily_search(client, query, &config.api_key, max_results).await,
        SearchProvider::SerpApi => {
            serpapi_search(
                client,
                query,
                &config.api_key,
                max_results,
                &config.serp_api_engine,
            )
            .await
        }
        SearchProvider::SearXng => {
            searxng_search(
                client,
                query,
                &config.searxng_url,
                max_results,
                &config.searxng_categories,
            )
            .await
        }
        SearchProvider::Ollama => ollama_search(client, query, &config.api_key, max_results).await,
        SearchProvider::Brave => brave_search(client, query, &config.api_key, max_results).await,
        SearchProvider::Firecrawl => {
            firecrawl_search(client, query, &config.api_key, max_results).await
        }
    }
}

async fn tavily_search(
    client: &reqwest::Client,
    query: &str,
    api_key: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, WebSearchError> {
    let url = std::env::var("LLM_WIKI_TAVILY_SEARCH_URL")
        .unwrap_or_else(|_| "https://api.tavily.com/search".to_string());
    let response = client
        .post(url)
        .json(&json!({
            "api_key": api_key,
            "query": query,
            "max_results": max_results,
            "search_depth": "advanced",
            "include_answer": false,
        }))
        .send()
        .await
        .map_err(|err| {
            WebSearchError::Request(format!(
                "Network error reaching api.tavily.com. Check your connectivity and whether the Tavily API key is still valid. {err}"
            ))
        })?;
    let data = json_response(response, "Tavily search").await?;
    Ok(normalize_tavily_results(&data, max_results))
}

async fn serpapi_search(
    client: &reqwest::Client,
    query: &str,
    api_key: &str,
    max_results: usize,
    engine: &str,
) -> Result<Vec<WebSearchResult>, WebSearchError> {
    let base = std::env::var("LLM_WIKI_SERPAPI_SEARCH_URL")
        .unwrap_or_else(|_| "https://serpapi.com/search".to_string());
    let mut url = reqwest::Url::parse(&base)
        .map_err(|err| WebSearchError::Config(format!("Invalid SerpApi URL: {err}")))?;
    url.query_pairs_mut()
        .append_pair("engine", engine)
        .append_pair("q", query)
        .append_pair("api_key", api_key)
        .append_pair("num", &max_results.to_string());
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| {
            WebSearchError::Request(format!(
                "Network error reaching serpapi.com. Check your connectivity and whether the SerpApi API key is still valid. {err}"
            ))
        })?;
    let data = json_response(response, "SerpApi search").await?;
    if let Some(error) = data
        .get("error")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        return Err(WebSearchError::Request(format!(
            "SerpApi search failed: {error}"
        )));
    }
    Ok(normalize_serpapi_results(&data, max_results))
}

async fn searxng_search(
    client: &reqwest::Client,
    query: &str,
    instance_url: &str,
    max_results: usize,
    categories: &[String],
) -> Result<Vec<WebSearchResult>, WebSearchError> {
    let mut url = searxng_search_url(instance_url)?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("format", "json")
        .append_pair(
            "categories",
            &if categories.is_empty() {
                "general".to_string()
            } else {
                categories.join(",")
            },
        );
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| {
            WebSearchError::Request(format!(
                "Network error reaching the SearXNG instance. Check the instance URL and whether JSON search is enabled. {err}"
            ))
        })?;
    let data = json_response(response, "SearXNG search").await?;
    Ok(normalize_searxng_results(&data, max_results))
}

fn searxng_search_url(instance_url: &str) -> Result<reqwest::Url, WebSearchError> {
    let trimmed = instance_url.trim();
    let with_protocol = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut url = reqwest::Url::parse(&with_protocol).map_err(|_| {
        WebSearchError::Config(
            "Invalid SearXNG instance URL. Use a valid http(s) URL, for example https://search.example.com.".to_string(),
        )
    })?;
    let path = url.path().trim_end_matches('/').to_string();
    if path != "/search" && !path.ends_with("/search") {
        let next = if path.is_empty() || path == "/" {
            "/search".to_string()
        } else {
            format!("{path}/search")
        };
        url.set_path(&next);
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn ollama_search(
    client: &reqwest::Client,
    query: &str,
    api_key: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, WebSearchError> {
    let url = std::env::var("LLM_WIKI_OLLAMA_SEARCH_URL")
        .unwrap_or_else(|_| "https://ollama.com/api/web_search".to_string());
    let response = client
        .post(url)
        .bearer_auth(api_key.trim())
        .json(&json!({ "query": query, "max_results": max_results }))
        .send()
        .await
        .map_err(|err| {
            WebSearchError::Request(format!(
                "Network error reaching the Ollama Web Search API. Check your connectivity and whether the Ollama API key is still valid. {err}"
            ))
        })?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(WebSearchError::Request(
            "Ollama Web Search API authentication failed. Check your Ollama API key.".to_string(),
        ));
    }
    let data = json_response(response, "Ollama web search").await?;
    if let Some(error) = data
        .get("error")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        return Err(WebSearchError::Request(format!(
            "Ollama web search error: {error}"
        )));
    }
    Ok(normalize_ollama_results(&data, max_results))
}

async fn brave_search(
    client: &reqwest::Client,
    query: &str,
    api_key: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, WebSearchError> {
    let base = std::env::var("LLM_WIKI_BRAVE_SEARCH_URL")
        .unwrap_or_else(|_| "https://api.search.brave.com/res/v1/web/search".to_string());
    let count = max_results.clamp(1, 20);
    let mut url = reqwest::Url::parse(&base)
        .map_err(|err| WebSearchError::Config(format!("Invalid Brave search URL: {err}")))?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("count", &count.to_string());
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await
        .map_err(|err| {
            WebSearchError::Request(format!(
                "Network error reaching api.search.brave.com. Check your connectivity and whether the Brave Search API key is still valid. {err}"
            ))
        })?;
    if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
        return Err(WebSearchError::Request(
            "Brave Search API authentication failed. Check your subscription token in Settings."
                .to_string(),
        ));
    }
    let data = json_response(response, "Brave search").await?;
    if data.get("message").and_then(Value::as_str).is_some() && data.get("web").is_none() {
        return Err(WebSearchError::Request(format!(
            "Brave search error: {}",
            data.get("message")
                .and_then(Value::as_str)
                .unwrap_or("Unknown error")
        )));
    }
    Ok(normalize_brave_results(&data, max_results))
}

async fn firecrawl_search(
    client: &reqwest::Client,
    query: &str,
    api_key: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, WebSearchError> {
    let url = std::env::var("LLM_WIKI_FIRECRAWL_SEARCH_URL")
        .unwrap_or_else(|_| "https://api.firecrawl.dev/v2/search".to_string());
    let mut request = client
        .post(url)
        .header("Accept", "application/json")
        .json(&json!({ "query": query, "limit": max_results }));
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request.send().await.map_err(|err| {
        WebSearchError::Request(format!(
            "Network error reaching Firecrawl Search. Check your connectivity or choose another Web Search provider. {err}"
        ))
    })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let data: Value = serde_json::from_str(&text).map_err(|err| {
        if !status.is_success() {
            WebSearchError::Request(format!(
                "Firecrawl search failed ({status}): {}",
                if text.is_empty() {
                    "Unknown error"
                } else {
                    &text
                }
            ))
        } else {
            WebSearchError::Request(format!(
                "Firecrawl search returned an invalid JSON response: {err}"
            ))
        }
    })?;
    if !status.is_success() {
        return Err(WebSearchError::Request(
            friendly_firecrawl_error(&data).unwrap_or_else(|| {
                format!(
                    "Firecrawl search failed ({status}): {}",
                    if text.is_empty() {
                        "Unknown error"
                    } else {
                        &text
                    }
                )
            }),
        ));
    }
    let success_false = data.get("success").and_then(Value::as_bool) == Some(false);
    let has_error = data
        .get("error")
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if success_false || has_error {
        return Err(WebSearchError::Request(
            friendly_firecrawl_error(&data).unwrap_or_else(|| {
                format!(
                    "Firecrawl search failed: {}",
                    data.get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown error")
                )
            }),
        ));
    }
    Ok(normalize_firecrawl_results(&data, max_results))
}

async fn json_response(
    response: reqwest::Response,
    context: &str,
) -> Result<Value, WebSearchError> {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(WebSearchError::Request(format!(
            "{context} failed ({status}): {}",
            if text.is_empty() {
                "Unknown error"
            } else {
                &text
            }
        )));
    }
    serde_json::from_str(&text).map_err(|err| {
        WebSearchError::Request(format!(
            "{context} returned an invalid JSON response: {err}"
        ))
    })
}

fn friendly_firecrawl_error(data: &Value) -> Option<String> {
    let message = data.get("error").and_then(Value::as_str)?.trim();
    if message.is_empty() {
        return None;
    }
    if message.contains("suspicious")
        || message.contains("without an API key")
        || message
            .to_ascii_lowercase()
            .contains("firecrawl can't be used without an api key")
    {
        return Some("Firecrawl anonymous search is blocked for this IP. Firecrawl says this network looks suspicious; choose another Web Search provider or try a different network.".to_string());
    }
    Some(format!("Firecrawl search failed: {message}"))
}

pub(super) fn normalize_tavily_results(data: &Value, max_results: usize) -> Vec<WebSearchResult> {
    data.get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(max_results)
        .map(|item| {
            let url = string_value(item, "url");
            WebSearchResult {
                title: string_value(item, "title")
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled")
                    .to_string(),
                url: url.unwrap_or("").to_string(),
                snippet: string_value(item, "content").unwrap_or("").to_string(),
                source: hostname_from_url(url.unwrap_or("")),
                provider: String::new(),
                rank: 0,
                score: number_value(item, "score"),
                query: None,
                searched_at: None,
                markdown: None,
                content: None,
            }
        })
        .filter(|item| !item.url.is_empty())
        .collect()
}

pub(super) fn normalize_serpapi_results(data: &Value, max_results: usize) -> Vec<WebSearchResult> {
    let raw = [
        "organic_results",
        "news_results",
        "images_results",
        "video_results",
        "videos_results",
        "shopping_results",
    ]
    .iter()
    .find_map(|key| data.get(*key).and_then(Value::as_array))
    .into_iter()
    .flatten();
    raw.take(max_results)
        .map(|item| {
            let url = first_string(item, &["link", "url", "original", "thumbnail"]).unwrap_or("");
            WebSearchResult {
                title: string_value(item, "title")
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled")
                    .to_string(),
                url: url.to_string(),
                snippet: first_string(item, &["snippet", "summary", "description"])
                    .unwrap_or("")
                    .to_string(),
                source: non_empty(hostname_from_url(url)).unwrap_or_else(|| {
                    first_string(item, &["source", "displayed_link"])
                        .unwrap_or("")
                        .to_string()
                }),
                provider: String::new(),
                rank: 0,
                score: number_value(item, "score"),
                query: None,
                searched_at: None,
                markdown: None,
                content: None,
            }
        })
        .filter(|item| !item.url.is_empty())
        .collect()
}

pub(super) fn normalize_searxng_results(data: &Value, max_results: usize) -> Vec<WebSearchResult> {
    data.get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(max_results)
        .map(|item| {
            let url = string_value(item, "url").unwrap_or("");
            WebSearchResult {
                title: string_value(item, "title")
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled")
                    .to_string(),
                url: url.to_string(),
                snippet: string_value(item, "content").unwrap_or("").to_string(),
                source: non_empty(hostname_from_url(url)).unwrap_or_else(|| {
                    first_string(item, &["engine", "category"])
                        .unwrap_or("")
                        .to_string()
                }),
                provider: String::new(),
                rank: 0,
                score: number_value(item, "score"),
                query: None,
                searched_at: None,
                markdown: None,
                content: None,
            }
        })
        .filter(|item| !item.url.is_empty())
        .collect()
}

fn normalize_ollama_results(data: &Value, max_results: usize) -> Vec<WebSearchResult> {
    data.get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(max_results)
        .map(|item| {
            let url = string_value(item, "url").unwrap_or("");
            WebSearchResult {
                title: string_value(item, "title")
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled")
                    .to_string(),
                url: url.to_string(),
                snippet: string_value(item, "content").unwrap_or("").to_string(),
                source: hostname_from_url(url),
                provider: String::new(),
                rank: 0,
                score: None,
                query: None,
                searched_at: None,
                markdown: None,
                content: None,
            }
        })
        .filter(|item| !item.url.is_empty())
        .collect()
}

pub(super) fn normalize_brave_results(data: &Value, max_results: usize) -> Vec<WebSearchResult> {
    data.get("web")
        .and_then(|web| web.get("results"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(max_results)
        .map(|item| {
            let url = string_value(item, "url").unwrap_or("");
            WebSearchResult {
                title: string_value(item, "title")
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled")
                    .to_string(),
                url: url.to_string(),
                snippet: string_value(item, "description").unwrap_or("").to_string(),
                source: hostname_from_url(url),
                provider: String::new(),
                rank: 0,
                score: None,
                query: None,
                searched_at: None,
                markdown: None,
                content: None,
            }
        })
        .filter(|item| !item.url.is_empty())
        .collect()
}

pub(super) fn normalize_firecrawl_results(
    data: &Value,
    max_results: usize,
) -> Vec<WebSearchResult> {
    extract_firecrawl_result_array(data)
        .into_iter()
        .take(max_results)
        .map(normalize_firecrawl_result)
        .filter(|item| !item.url.is_empty())
        .collect()
}

fn extract_firecrawl_result_array(data: &Value) -> Vec<&Value> {
    if let Some(items) = data.get("data").and_then(Value::as_array) {
        return items.iter().collect();
    }
    if let Some(items) = data.get("results").and_then(Value::as_array) {
        return items.iter().collect();
    }
    for root_key in ["data", "results"] {
        let Some(root) = data.get(root_key).and_then(Value::as_object) else {
            continue;
        };
        for nested_key in ["web", "results", "items"] {
            if let Some(items) = root.get(nested_key).and_then(Value::as_array) {
                return items.iter().collect();
            }
        }
    }
    Vec::new()
}

fn normalize_firecrawl_result(item: &Value) -> WebSearchResult {
    let metadata = item.get("metadata").unwrap_or(&Value::Null);
    let url = first_string(item, &["url", "link"])
        .or_else(|| first_string(metadata, &["sourceURL", "url"]))
        .unwrap_or("");
    let markdown = string_value(item, "markdown").map(str::to_string);
    let content = string_value(item, "content").map(str::to_string);
    WebSearchResult {
        title: string_value(item, "title")
            .or_else(|| string_value(metadata, "title"))
            .filter(|s| !s.is_empty())
            .unwrap_or("Untitled")
            .to_string(),
        url: url.to_string(),
        snippet: first_string(item, &["snippet", "description"])
            .or_else(|| string_value(metadata, "description"))
            .or(content.as_deref())
            .or(markdown.as_deref())
            .unwrap_or("")
            .to_string(),
        source: non_empty(hostname_from_url(url))
            .unwrap_or_else(|| string_value(item, "source").unwrap_or("").to_string()),
        provider: String::new(),
        rank: 0,
        score: number_value(item, "score"),
        query: None,
        searched_at: None,
        markdown,
        content,
    }
}

fn string_value<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| string_value(value, key))
}

fn number_value(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub(super) fn hostname_from_url(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| host.trim_start_matches("www.").to_string())
        })
        .unwrap_or_default()
}
