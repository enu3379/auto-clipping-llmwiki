use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::web_search::{
    ClipExtractMode, ClipSearchRequest, SkippedClip, WebSearchRequest, WebSearchResponse,
    WebSearchResult, WrittenClip,
};

const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:19828";

pub fn try_run_from_env() -> Result<bool, String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        return Ok(false);
    }
    if args.len() == 1 && args[0].starts_with("-psn_") {
        return Ok(false);
    }
    tauri::async_runtime::block_on(run(args))?;
    Ok(true)
}

async fn run(args: Vec<String>) -> Result<(), String> {
    let Some((command, rest)) = args.split_first() else {
        return Ok(());
    };
    match command.as_str() {
        "web-search" if wants_help(rest) => {
            println!("{}", web_search_usage());
            Ok(())
        }
        "web-search" => run_web_search(parse_web_search_args(rest)?).await,
        "clip-search" if wants_help(rest) => {
            println!("{}", clip_search_usage());
            Ok(())
        }
        "clip-search" => run_clip_search(parse_clip_search_args(rest)?).await,
        "-h" | "--help" | "help" => {
            print_help();
            Ok(())
        }
        other => Err(format!(
            "Unknown llm-wiki CLI command: {other}\n\n{}",
            usage()
        )),
    }
}

fn wants_help(args: &[String]) -> bool {
    args.iter()
        .any(|arg| matches!(arg.as_str(), "-h" | "--help" | "help"))
}

#[derive(Debug, Clone)]
struct CommonArgs {
    api_base_url: String,
    token: Option<String>,
    project_id: String,
}

impl Default for CommonArgs {
    fn default() -> Self {
        Self {
            api_base_url: env::var("LLM_WIKI_API_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string()),
            token: env::var("LLM_WIKI_API_TOKEN")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            project_id: "current".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
struct WebSearchCliArgs {
    common: CommonArgs,
    queries: Vec<String>,
    provider: Option<String>,
    max_results: Option<usize>,
    out: Option<PathBuf>,
    summary_limit: usize,
}

#[derive(Debug, Clone)]
struct ClipSearchCliArgs {
    common: CommonArgs,
    run_file: PathBuf,
    indexes: Vec<usize>,
    all: bool,
    query: Option<String>,
    extract: ClipExtractMode,
    whitelist: Vec<String>,
    blacklist: Vec<String>,
    allow_private_hosts: Option<bool>,
    actor: Option<String>,
    enqueue: bool,
    out: Option<PathBuf>,
}

fn parse_web_search_args(args: &[String]) -> Result<WebSearchCliArgs, String> {
    let mut parsed = WebSearchCliArgs {
        common: CommonArgs::default(),
        queries: Vec::new(),
        provider: None,
        max_results: None,
        out: None,
        summary_limit: 5,
    };
    let mut positional = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--api-base-url" => parsed.common.api_base_url = take_value(args, &mut i)?,
            "--token" => parsed.common.token = Some(take_value(args, &mut i)?),
            "-p" | "--project" => parsed.common.project_id = take_value(args, &mut i)?,
            "-q" | "--query" => parsed.queries.push(take_value(args, &mut i)?),
            "--provider" => parsed.provider = Some(take_value(args, &mut i)?),
            "-n" | "--max-results" => {
                parsed.max_results = Some(parse_usize(&take_value(args, &mut i)?, "max-results")?)
            }
            "-o" | "--out" => parsed.out = Some(PathBuf::from(take_value(args, &mut i)?)),
            "--summary-limit" => {
                parsed.summary_limit = parse_usize(&take_value(args, &mut i)?, "summary-limit")?
            }
            "-h" | "--help" => return Err(web_search_usage()),
            "--" => {
                positional.extend(args[i + 1..].iter().cloned());
                break;
            }
            value if value.starts_with('-') => {
                return Err(format!("Unknown web-search option: {value}"))
            }
            value => positional.push(value.to_string()),
        }
        i += 1;
    }
    if parsed.queries.is_empty() && !positional.is_empty() {
        parsed.queries.push(positional.join(" "));
    }
    if parsed.queries.is_empty() {
        return Err(format!(
            "web-search requires --query or a positional query\n\n{}",
            web_search_usage()
        ));
    }
    Ok(parsed)
}

fn parse_clip_search_args(args: &[String]) -> Result<ClipSearchCliArgs, String> {
    let mut parsed = ClipSearchCliArgs {
        common: CommonArgs::default(),
        run_file: PathBuf::new(),
        indexes: Vec::new(),
        all: false,
        query: None,
        extract: ClipExtractMode::Selected,
        whitelist: Vec::new(),
        blacklist: Vec::new(),
        allow_private_hosts: None,
        actor: Some("llm-wiki-cli".to_string()),
        enqueue: true,
        out: None,
    };
    let mut positional = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--api-base-url" => parsed.common.api_base_url = take_value(args, &mut i)?,
            "--token" => parsed.common.token = Some(take_value(args, &mut i)?),
            "-p" | "--project" => parsed.common.project_id = take_value(args, &mut i)?,
            "-f" | "--run-file" => parsed.run_file = PathBuf::from(take_value(args, &mut i)?),
            "--indexes" => parsed
                .indexes
                .extend(parse_indexes(&take_value(args, &mut i)?)?),
            "--all" => parsed.all = true,
            "--query" => parsed.query = Some(take_value(args, &mut i)?),
            "--extract" => parsed.extract = parse_extract_mode(&take_value(args, &mut i)?)?,
            "--whitelist" | "--allowlist" => parsed
                .whitelist
                .extend(parse_string_list(&take_value(args, &mut i)?)),
            "--blacklist" | "--blocklist" => parsed
                .blacklist
                .extend(parse_string_list(&take_value(args, &mut i)?)),
            "--allow-private-hosts" => parsed.allow_private_hosts = Some(true),
            "--actor" => parsed.actor = Some(take_value(args, &mut i)?),
            "--enqueue" => parsed.enqueue = true,
            "--no-enqueue" => parsed.enqueue = false,
            "-o" | "--out" => parsed.out = Some(PathBuf::from(take_value(args, &mut i)?)),
            "-h" | "--help" => return Err(clip_search_usage()),
            "--" => {
                positional.extend(args[i + 1..].iter().cloned());
                break;
            }
            value if value.starts_with('-') => {
                return Err(format!("Unknown clip-search option: {value}"))
            }
            value => positional.push(value.to_string()),
        }
        i += 1;
    }
    if parsed.run_file.as_os_str().is_empty() {
        if let Some(first) = positional.first() {
            parsed.run_file = PathBuf::from(first);
        }
    }
    if parsed.run_file.as_os_str().is_empty() {
        return Err(format!(
            "clip-search requires --run-file\n\n{}",
            clip_search_usage()
        ));
    }
    if !parsed.all && parsed.indexes.is_empty() {
        return Err("clip-search requires --indexes or --all".to_string());
    }
    Ok(parsed)
}

async fn run_web_search(args: WebSearchCliArgs) -> Result<(), String> {
    let response: WebSearchResponse = api_json(
        &args.common,
        &format!(
            "/projects/{}/web-search",
            percent_encode_path_segment(&args.common.project_id)
        ),
        &WebSearchRequest {
            queries: args.queries,
            provider: args.provider,
            max_results: args.max_results,
        },
    )
    .await?;
    let out = args
        .out
        .unwrap_or_else(|| default_run_file_path(&response.run_id));
    write_json_file(&out, &response)?;
    print_json(&web_search_summary(&response, &out, args.summary_limit))
}

async fn run_clip_search(args: ClipSearchCliArgs) -> Result<(), String> {
    let run: WebSearchResponse = read_json_file(&args.run_file)?;
    let indexes = if args.all {
        (1..=run.results.len()).collect::<Vec<_>>()
    } else {
        args.indexes.clone()
    };
    let selected = select_results(&run.results, &indexes)?;
    let query = args
        .query
        .or_else(|| selected.iter().find_map(|result| result.query.clone()))
        .unwrap_or_else(|| "web-search".to_string());
    let response: ClipApiResponse = api_json(
        &args.common,
        &format!(
            "/projects/{}/web-search/clip",
            percent_encode_path_segment(&args.common.project_id)
        ),
        &ClipSearchRequest {
            query,
            run_id: Some(run.run_id.clone()),
            results: selected,
            extract: args.extract,
            whitelist: args.whitelist,
            blacklist: args.blacklist,
            allow_private_hosts: args.allow_private_hosts,
            actor: args.actor,
            origin: Some(json!({
                "type": "cli",
                "tool": "llm-wiki",
                "runFile": args.run_file.to_string_lossy(),
            })),
            origin_log: None,
            enqueue: args.enqueue,
        },
    )
    .await?;
    if let Some(out) = args.out.as_ref() {
        write_json_file(out, &response)?;
    }
    print_json(&clip_search_summary(
        &response,
        &run.run_id,
        &args.run_file,
        &indexes,
        args.out.as_ref(),
    ))
}

async fn api_json<T, R>(common: &CommonArgs, path: &str, body: &T) -> Result<R, String>
where
    T: Serialize + ?Sized,
    R: for<'de> Deserialize<'de>,
{
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/v1{}",
        common.api_base_url.trim_end_matches('/'),
        path
    );
    let mut request = client
        .post(url)
        .header("Accept", "application/json")
        .json(body);
    if let Some(token) = common
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("LLM Wiki API request failed. Is the desktop app running? {err}"))?;
    parse_api_response(response).await
}

async fn parse_api_response<R>(response: reqwest::Response) -> Result<R, String>
where
    R: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let value: Value = serde_json::from_str(&text).map_err(|err| {
        format!(
            "LLM Wiki API returned non-JSON response ({status}): {} ({err})",
            text.chars().take(300).collect::<String>()
        )
    })?;
    if !status.is_success() || value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(api_error_message(status, &value));
    }
    serde_json::from_value(value)
        .map_err(|err| format!("Failed to parse LLM Wiki API response: {err}"))
}

fn api_error_message(status: StatusCode, value: &Value) -> String {
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Unknown error");
    format!("LLM Wiki API {status}: {message}")
}

fn select_results(
    results: &[WebSearchResult],
    indexes: &[usize],
) -> Result<Vec<WebSearchResult>, String> {
    let mut selected = Vec::new();
    for index in indexes {
        if *index == 0 || *index > results.len() {
            return Err(format!(
                "Result index {index} is out of range; run file has {} results",
                results.len()
            ));
        }
        selected.push(results[*index - 1].clone());
    }
    Ok(selected)
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create output directory '{}': {err}",
                parent.display()
            )
        })?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Failed to serialize JSON output: {err}"))?;
    fs::write(path, format!("{content}\n"))
        .map_err(|err| format!("Failed to write '{}': {err}", path.display()))
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read '{}': {err}", path.display()))?;
    serde_json::from_str(&raw).map_err(|err| format!("Invalid JSON in '{}': {err}", path.display()))
}

fn print_json(value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Failed to serialize CLI output: {err}"))?;
    println!("{text}");
    Ok(())
}

fn web_search_summary(response: &WebSearchResponse, out: &Path, summary_limit: usize) -> Value {
    json!({
        "ok": true,
        "command": "web-search",
        "projectId": response.project_id,
        "runId": response.run_id,
        "provider": response.provider,
        "resultPath": out,
        "resultCount": response.results.len(),
        "errorCount": response.errors.len(),
        "results": response.results.iter().take(summary_limit).enumerate().map(|(idx, result)| {
            json!({
                "index": idx + 1,
                "title": result.title,
                "url": result.url,
                "source": result.source,
                "provider": result.provider,
                "rank": result.rank,
                "query": result.query,
            })
        }).collect::<Vec<_>>(),
        "errors": response.errors,
    })
}

fn clip_search_summary(
    response: &ClipApiResponse,
    run_id: &str,
    run_file: &Path,
    indexes: &[usize],
    out: Option<&PathBuf>,
) -> Value {
    json!({
        "ok": true,
        "command": "clip-search",
        "projectId": response.project_id,
        "runId": run_id,
        "runFile": run_file,
        "selectedIndexes": indexes,
        "written": response.written,
        "skipped": response.skipped,
        "enqueue": response.enqueue,
        "enqueueError": response.enqueue_error,
        "responsePath": out,
    })
}

fn default_run_file_path(run_id: &str) -> PathBuf {
    PathBuf::from(".llm-wiki")
        .join("runs")
        .join("web-search")
        .join(format!("{run_id}.json"))
}

fn take_value(args: &[String], index: &mut usize) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| "Missing value for option".to_string())
}

fn parse_usize(value: &str, name: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|_| format!("{name} must be a positive integer"))
}

fn parse_indexes(value: &str) -> Result<Vec<usize>, String> {
    let mut indexes = Vec::new();
    for item in value.split(',') {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }
        indexes.push(parse_usize(trimmed, "indexes")?);
    }
    if indexes.is_empty() {
        return Err("indexes must contain at least one number".to_string());
    }
    Ok(indexes)
}

fn parse_string_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_extract_mode(value: &str) -> Result<ClipExtractMode, String> {
    match value {
        "none" => Ok(ClipExtractMode::None),
        "selected" => Ok(ClipExtractMode::Selected),
        other => Err(format!(
            "extract must be 'none' or 'selected', got '{other}'"
        )),
    }
}

fn percent_encode_path_segment(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipApiResponse {
    #[serde(default)]
    ok: bool,
    project_id: Option<String>,
    written: Vec<WrittenClip>,
    skipped: Vec<SkippedClip>,
    enqueue: Option<bool>,
    #[serde(default)]
    enqueue_result: Option<Value>,
    #[serde(default)]
    enqueue_error: Option<String>,
}

fn print_help() {
    println!("{}", usage());
}

fn usage() -> String {
    format!("{}\n\n{}", web_search_usage(), clip_search_usage())
}

fn web_search_usage() -> String {
    "Usage: llm-wiki web-search [options] <query>\n\
     Options: --query <q> --provider <name> --max-results <n> --out <file> --project <id> --api-base-url <url> --token <token>"
        .to_string()
}

fn clip_search_usage() -> String {
    "Usage: llm-wiki clip-search --run-file <file> --indexes <1,2> [options]\n\
     Options: --all --extract <selected|none> --whitelist <patterns> --blacklist <patterns> --allow-private-hosts --no-enqueue --out <file>"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_comma_separated_indexes() {
        assert_eq!(parse_indexes("1, 3,5").unwrap(), vec![1, 3, 5]);
        assert!(parse_indexes("").is_err());
    }

    #[test]
    fn encodes_project_path_for_api_url_segment() {
        assert_eq!(
            percent_encode_path_segment("/tmp/My Project"),
            "%2Ftmp%2FMy%20Project"
        );
    }

    #[test]
    fn web_search_positional_words_become_one_query() {
        let args = parse_web_search_args(&["hello".into(), "world".into()]).unwrap();
        assert_eq!(args.queries, vec!["hello world"]);
    }

    #[test]
    fn clip_search_requires_indexes_unless_all() {
        assert!(parse_clip_search_args(&["--run-file".into(), "run.json".into()]).is_err());
        let args =
            parse_clip_search_args(&["--run-file".into(), "run.json".into(), "--all".into()])
                .unwrap();
        assert!(args.all);
    }
}
