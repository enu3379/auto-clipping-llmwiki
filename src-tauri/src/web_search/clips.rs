use super::providers::hostname_from_url;
use super::*;

pub async fn clip_search_results(
    project_path: &str,
    request: ClipSearchRequest,
) -> Result<ClipSearchResponse, String> {
    let policy = ClipUrlPolicy::from_request(&request);
    clip_search_results_with_policy(project_path, request, policy).await
}

pub async fn clip_search_results_with_policy(
    project_path: &str,
    request: ClipSearchRequest,
    policy: ClipUrlPolicy,
) -> Result<ClipSearchResponse, String> {
    if request.query.trim().is_empty() {
        return Err("query is required".to_string());
    }
    if request.results.is_empty() {
        return Err("results must be a non-empty array".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(EXTRACT_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("Extraction HTTP client error: {err}"))?;
    let date = Local::now().format("%Y-%m-%d").to_string();
    let dest_dir = Path::new(project_path)
        .join("raw")
        .join("sources")
        .join("search")
        .join(&date);
    fs::create_dir_all(&dest_dir)
        .map_err(|err| format!("Failed to create search clip directory: {err}"))?;
    let clipped_at = now_rfc3339();
    let compact_timestamp = compact_timestamp();
    let actor = request
        .actor
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("local-api")
        .to_string();
    let origin_log = request.origin_log.or(request.origin);
    let mut written = Vec::new();
    let mut skipped = Vec::new();

    for (idx, result) in request.results.iter().enumerate() {
        let rank = if result.rank > 0 {
            result.rank
        } else {
            idx + 1
        };
        if let Some(reason) = policy.skip_reason(&result.url) {
            skipped.push(SkippedClip {
                title: normalized_title(&result.title),
                url: result.url.clone(),
                provider: normalized_provider(result),
                rank,
                reason,
            });
            continue;
        }
        let extraction = extract_for_clip(&client, result, &request.extract).await;
        let filename = search_clip_filename(&result.url, &result.title, &compact_timestamp);
        let path = unique_markdown_path(&dest_dir, &filename)
            .map_err(|err| format!("Failed to allocate clip filename: {err}"))?;
        let rel_path = relative_search_clip_path(
            &date,
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("clip.md"),
        );
        let markdown = render_search_clip_markdown(
            result,
            &request.query,
            request.run_id.as_deref(),
            rank,
            &clipped_at,
            &actor,
            origin_log.as_ref(),
            &extraction,
        );
        fs::write(&path, markdown)
            .map_err(|err| format!("Failed to write search clip '{}': {err}", path.display()))?;
        written.push(WrittenClip {
            path: rel_path,
            title: normalized_title(&result.title),
            url: result.url.clone(),
            provider: normalized_provider(result),
            rank,
            extraction_status: extraction.status.clone(),
            extraction_error: extraction.error.clone(),
        });
    }

    Ok(ClipSearchResponse { written, skipped })
}

#[derive(Debug, Clone)]
pub(super) struct ClipExtraction {
    pub(super) status: String,
    pub(super) content: String,
    pub(super) error: Option<String>,
}

async fn extract_for_clip(
    client: &reqwest::Client,
    result: &WebSearchResult,
    mode: &ClipExtractMode,
) -> ClipExtraction {
    if mode == &ClipExtractMode::None {
        return ClipExtraction {
            status: "skipped".to_string(),
            content: snippet_body(result),
            error: None,
        };
    }

    if let Some(markdown) = result
        .markdown
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return ClipExtraction {
            status: "success".to_string(),
            content: markdown.to_string(),
            error: None,
        };
    }
    if result.provider == "firecrawl" {
        if let Some(content) = result
            .content
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return ClipExtraction {
                status: "success".to_string(),
                content: content.to_string(),
                error: None,
            };
        }
    }

    match jina_reader_extract(client, &result.url).await {
        Ok(content) if !content.trim().is_empty() => ClipExtraction {
            status: "success".to_string(),
            content,
            error: None,
        },
        Ok(_) => ClipExtraction {
            status: "failed".to_string(),
            content: snippet_body(result),
            error: Some("Reader extraction returned empty content".to_string()),
        },
        Err(err) => ClipExtraction {
            status: "failed".to_string(),
            content: snippet_body(result),
            error: Some(err),
        },
    }
}

async fn jina_reader_extract(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|err| format!("Invalid URL: {err}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http(s) URLs can be extracted".to_string());
    }
    let reader_url = format!("https://r.jina.ai/{url}");
    let response = client
        .get(reader_url)
        .header("Accept", "text/markdown, text/plain;q=0.9, */*;q=0.1")
        .send()
        .await
        .map_err(|err| format!("Reader extraction request failed: {err}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Reader extraction failed ({status}): {}",
            text.chars().take(200).collect::<String>()
        ));
    }
    Ok(text)
}

pub(super) fn snippet_body(result: &WebSearchResult) -> String {
    let mut body = String::new();
    body.push_str(&format!("# {}\n\n", normalized_title(&result.title)));
    if !result.snippet.trim().is_empty() {
        body.push_str(result.snippet.trim());
        body.push_str("\n\n");
    }
    body.push_str(&format!("- URL: {}\n", result.url));
    body.push_str(&format!("- Provider: {}\n", normalized_provider(result)));
    if !result.source.trim().is_empty() {
        body.push_str(&format!("- Source: {}\n", result.source.trim()));
    }
    body
}

pub(super) fn render_search_clip_markdown(
    result: &WebSearchResult,
    query: &str,
    run_id: Option<&str>,
    rank: usize,
    clipped_at: &str,
    actor: &str,
    origin_log: Option<&Value>,
    extraction: &ClipExtraction,
) -> String {
    let searched_at = result.searched_at.as_deref().unwrap_or(clipped_at);
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("type: clip\n");
    out.push_str("origin: web-search\n");
    out.push_str(&format!(
        "title: {}\n",
        yaml_string(&normalized_title(&result.title))
    ));
    out.push_str(&format!("url: {}\n", yaml_string(&result.url)));
    out.push_str(&format!(
        "provider: {}\n",
        yaml_string(&normalized_provider(result))
    ));
    out.push_str(&format!("query: {}\n", yaml_string(query.trim())));
    out.push_str(&format!(
        "search_run_id: {}\n",
        yaml_string(run_id.unwrap_or(""))
    ));
    out.push_str(&format!("rank: {rank}\n"));
    out.push_str(&format!("searched_at: {}\n", yaml_string(searched_at)));
    out.push_str(&format!("clipped_at: {}\n", yaml_string(clipped_at)));
    out.push_str(&format!("actor: {}\n", yaml_string(actor)));
    out.push_str("sources: []\n");
    out.push_str("tags: [web-search]\n");
    out.push_str(&format!(
        "extraction_status: {}\n",
        yaml_string(&extraction.status)
    ));
    if let Some(error) = extraction.error.as_deref() {
        out.push_str(&format!("extraction_error: {}\n", yaml_string(error)));
    }
    if let Some(origin_log) = origin_log {
        out.push_str(&format!("origin_log: {}\n", json_inline(origin_log)));
    }
    out.push_str("---\n\n");
    out.push_str(extraction.content.trim());
    out.push('\n');
    out
}

fn normalized_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalized_provider(result: &WebSearchResult) -> String {
    let provider = result.provider.trim();
    if provider.is_empty() {
        "unknown".to_string()
    } else {
        provider.to_string()
    }
}

pub(super) fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn json_inline(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

pub fn search_clip_filename(url: &str, title: &str, compact_timestamp: &str) -> String {
    let host = hostname_from_url(url);
    let host_slug = host_slugify(&host, "web", 48);
    let title_slug = slugify(title, "untitled", 72);
    format!("{host_slug}-{title_slug}-{compact_timestamp}.md")
}

pub(super) fn unique_markdown_path(dir: &Path, filename: &str) -> std::io::Result<PathBuf> {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let stem = filename.trim_end_matches(".md");
    for suffix in 2..10_000 {
        let candidate = dir.join(format!("{stem}-{suffix}.md"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Ok(dir.join(format!("{stem}-{}.md", Uuid::new_v4())))
}

fn relative_search_clip_path(date: &str, filename: &str) -> String {
    format!("raw/sources/search/{date}/{filename}")
}

pub fn slugify(value: &str, fallback: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in value.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            previous_dash = false;
        } else if !previous_dash && !out.is_empty() {
            out.push('-');
            previous_dash = true;
        }
        if out.len() >= max_len {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

fn host_slugify(value: &str, fallback: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in value.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() || lower == '.' {
            out.push(lower);
            previous_dash = false;
        } else if !previous_dash && !out.is_empty() {
            out.push('-');
            previous_dash = true;
        }
        if out.len() >= max_len {
            break;
        }
    }
    let out = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

pub(super) fn now_rfc3339() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn compact_timestamp() -> String {
    Local::now().format("%Y%m%dT%H%M%S").to_string()
}
