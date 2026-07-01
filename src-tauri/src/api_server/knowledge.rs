use super::files::relative_to_project;
use super::*;
use crate::{commands, web_search};
use tauri::Emitter;
use uuid::Uuid;

const EVENT_SOURCE_INGEST_REQUESTED: &str = "source-ingest://requested";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    query: String,
    top_k: Option<usize>,
    include_content: Option<bool>,
    query_embedding: Option<Vec<f32>>,
}

pub(super) fn handle_search(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req: SearchRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    if req.query.trim().is_empty() {
        return err(400, "query is required");
    }
    let top_k = req.top_k.unwrap_or(10).clamp(1, MAX_SEARCH_RESULTS);
    let query = req.query;
    let query_embedding =
        match tauri::async_runtime::block_on(commands::search::resolve_query_embedding(
            &query,
            req.query_embedding,
            load_embedding_config(app),
        )) {
            Ok(embedding) => embedding,
            Err(e) => return err(400, e),
        };
    match tauri::async_runtime::block_on(commands::search::search_project_inner(
        project.path.clone(),
        query,
        top_k,
        req.include_content.unwrap_or(false),
        query_embedding,
    )) {
        Ok(search) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "mode": search.mode,
            "note": "Search uses the shared backend retrieval service. When embeddingConfig is enabled, the API automatically includes LanceDB vector results; clients may also pass queryEmbedding explicitly.",
            "tokenHits": search.token_hits,
            "vectorHits": search.vector_hits,
            "results": search.results,
        })),
        Err(e) => err(500, e),
    }
}

pub(super) fn handle_web_search(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req: web_search::WebSearchRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    match tauri::async_runtime::block_on(web_search::web_search(
        load_app_state(app).as_ref(),
        project.id.clone(),
        req,
    )) {
        Ok(search) => ok(json!({
            "ok": true,
            "projectId": search.project_id,
            "runId": search.run_id,
            "provider": search.provider,
            "results": search.results,
            "errors": search.errors,
        })),
        Err(e) => err(e.status_code(), e.message()),
    }
}

pub(super) fn handle_web_search_clip(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req: web_search::ClipSearchRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    let app_state = load_app_state(app);
    let policy = web_search::resolve_clip_url_policy(app_state.as_ref(), &req);
    let enqueue = req.enqueue;
    let clip = match tauri::async_runtime::block_on(web_search::clip_search_results_with_policy(
        &project.path,
        req,
        policy,
    )) {
        Ok(clip) => clip,
        Err(e) => return err(400, e),
    };

    let written_paths: Vec<String> = clip.written.iter().map(|item| item.path.clone()).collect();
    let mut enqueue_result = None;
    let mut enqueue_error = None;
    if enqueue {
        let source_watch_config = load_source_watch_config(app, &project.id);
        match commands::file_sync::rescan_project_files(
            app.clone(),
            project.id.clone(),
            project.path.clone(),
            source_watch_config,
        ) {
            Ok(result) => enqueue_result = Some(json!(result)),
            Err(e) => enqueue_error = Some(e),
        }
    }
    let source_watch_changed_count = enqueue_result
        .as_ref()
        .and_then(|value| value.get("changedTasks"))
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    let source_watch_rescan = json!({
        "requested": enqueue,
        "ok": enqueue && enqueue_error.is_none(),
        "changedCount": source_watch_changed_count,
        "error": enqueue_error.clone(),
    });
    let ingest_request = emit_source_ingest_request(
        app,
        &project,
        enqueue,
        &written_paths,
        source_watch_changed_count,
    );

    ok(json!({
        "ok": true,
        "projectId": project.id,
        "written": clip.written,
        "skipped": clip.skipped,
        "sourceWatchRescan": source_watch_rescan.clone(),
        "ingestRequest": ingest_request.clone(),
        "pipeline": {
            "rawSourcesWritten": written_paths.len(),
            "sourceWatchRescan": source_watch_rescan,
            "ingestRequest": ingest_request,
            "note": "Search clipping writes raw/sources files first. Wiki pages are produced asynchronously by the desktop ingest worker after Source Watch or a source-ingest request accepts the paths.",
        },
        "enqueue": enqueue,
        "enqueueResult": enqueue_result,
        "enqueueError": enqueue_error,
    }))
}

fn emit_source_ingest_request(
    app: &AppHandle,
    project: &ProjectEntry,
    enqueue: bool,
    source_paths: &[String],
    source_watch_changed_count: usize,
) -> Value {
    if !enqueue {
        return json!({
            "requested": false,
            "emitted": false,
            "status": "not_requested",
            "reason": "enqueue=false",
            "sourcePaths": source_paths,
        });
    }
    if source_watch_changed_count > 0 {
        return json!({
            "requested": true,
            "emitted": false,
            "status": "delegated_to_source_watch",
            "mode": "source-watch-rescan",
            "sourcePaths": source_paths,
            "sourceWatchChangedCount": source_watch_changed_count,
            "note": "Source Watch rescan detected written clips and emitted file-sync changes; the desktop file-sync listener owns ingest enqueue for these paths.",
        });
    }
    if source_paths.is_empty() {
        return json!({
            "requested": false,
            "emitted": false,
            "status": "not_requested",
            "reason": "no written clips",
            "sourcePaths": source_paths,
        });
    }

    let request_id = Uuid::new_v4().to_string();
    let payload = json!({
        "requestId": request_id,
        "projectId": project.id.clone(),
        "projectPath": project.path.clone(),
        "sourcePaths": source_paths,
        "origin": "web-search-clip",
    });
    match app.emit(EVENT_SOURCE_INGEST_REQUESTED, payload) {
        Ok(()) => json!({
            "requested": true,
            "emitted": true,
            "status": "requested",
            "requestId": request_id,
            "mode": "desktop-frontend-event",
            "sourcePaths": source_paths,
            "note": "Ingest runs asynchronously only when the desktop UI has this project active, Source Watch auto-ingest is enabled, and LLM config is usable.",
        }),
        Err(err) => json!({
            "requested": true,
            "emitted": false,
            "status": "failed",
            "requestId": request_id,
            "sourcePaths": source_paths,
            "reason": err.to_string(),
        }),
    }
}

fn load_embedding_config(app: &AppHandle) -> Option<commands::search::SearchEmbeddingConfig> {
    let parsed = load_app_state(app)?;
    let value = parsed.get("embeddingConfig")?.clone();
    serde_json::from_value::<commands::search::SearchEmbeddingConfig>(value).ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGraphNode {
    id: String,
    label: String,
    node_type: String,
    path: String,
    link_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGraphEdge {
    source: String,
    target: String,
    weight: f64,
}

pub(super) fn handle_graph(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let q = params.get("q").map(|s| s.to_lowercase());
    let node_type = params.get("nodeType").map(|s| s.to_lowercase());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 1000);

    match build_graph(&project.path) {
        Ok((mut nodes, edges)) => {
            if let Some(ref q) = q {
                nodes.retain(|n| {
                    n.id.to_lowercase().contains(q) || n.label.to_lowercase().contains(q)
                });
            }
            if let Some(ref node_type) = node_type {
                nodes.retain(|n| n.node_type == *node_type);
            }
            nodes.truncate(limit);
            let ids: BTreeSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
            let edges: Vec<ApiGraphEdge> = edges
                .into_iter()
                .filter(|e| ids.contains(&e.source) && ids.contains(&e.target))
                .collect();
            ok(json!({ "ok": true, "projectId": project.id, "nodes": nodes, "edges": edges }))
        }
        Err(e) => err(500, e),
    }
}

fn build_graph(project_path: &str) -> Result<(Vec<ApiGraphNode>, Vec<ApiGraphEdge>), String> {
    let wiki_root = Path::new(project_path).join("wiki");
    let mut raw: BTreeMap<String, (String, String, String, Vec<String>)> = BTreeMap::new();
    for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|s| s.to_str()) != Some("md")
        {
            continue;
        }
        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let id = entry
            .path()
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let title =
            commands::search::extract_title(&content, entry.file_name().to_string_lossy().as_ref());
        let node_type = extract_type(&content);
        let path = relative_to_project(project_path, entry.path());
        let links = extract_wikilinks(&content);
        raw.insert(id, (title, node_type, path, links));
    }
    let ids: BTreeSet<String> = raw.keys().cloned().collect();
    let mut link_count: BTreeMap<String, usize> = raw.keys().map(|id| (id.clone(), 0)).collect();
    let mut seen = BTreeSet::new();
    let mut edges = Vec::new();
    for (source, (_, _, _, links)) in &raw {
        for link in links {
            let Some(target) = resolve_link(link, &ids) else {
                continue;
            };
            if &target == source {
                continue;
            }
            let key = if source < &target {
                format!("{source}::{target}")
            } else {
                format!("{target}::{source}")
            };
            if seen.insert(key) {
                *link_count.entry(source.clone()).or_default() += 1;
                *link_count.entry(target.clone()).or_default() += 1;
                edges.push(ApiGraphEdge {
                    source: source.clone(),
                    target,
                    weight: 1.0,
                });
            }
        }
    }
    let nodes = raw
        .into_iter()
        .filter(|(_, (_, node_type, _, _))| node_type != "query")
        .map(|(id, (label, node_type, path, _))| ApiGraphNode {
            link_count: *link_count.get(&id).unwrap_or(&0),
            id,
            label,
            node_type,
            path,
        })
        .collect();
    Ok((nodes, edges))
}

fn extract_type(content: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.trim().strip_prefix("type:") {
            return value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_lowercase();
        }
    }
    "other".to_string()
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let inner = &rest[..end];
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    out
}

fn resolve_link(raw: &str, ids: &BTreeSet<String>) -> Option<String> {
    if ids.contains(raw) {
        return Some(raw.to_string());
    }
    let normalized = raw.to_lowercase().replace(' ', "-");
    ids.iter()
        .find(|id| id.to_lowercase() == normalized || id.to_lowercase() == raw.to_lowercase())
        .cloned()
}

pub(super) fn handle_rescan(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let source_watch_config = load_source_watch_config(app, &project.id);
    match commands::file_sync::rescan_project_files(
        app.clone(),
        project.id.clone(),
        project.path.clone(),
        source_watch_config,
    ) {
        Ok(result) => ok(json!({ "ok": true, "projectId": project.id, "result": result })),
        Err(e) => err(500, e),
    }
}

fn load_source_watch_config(
    app: &AppHandle,
    project_id: &str,
) -> Option<commands::file_sync::SourceWatchConfig> {
    let parsed = load_app_state(app)?;
    let settings = parsed.get("sourceWatchConfig").and_then(Value::as_object);
    if let Some(value) = settings
        .and_then(|s| s.get(project_id).or_else(|| s.get("default")))
        .cloned()
    {
        if let Ok(config) = serde_json::from_value::<commands::file_sync::SourceWatchConfig>(value)
        {
            return Some(config);
        }
    }
    let legacy_enabled = parsed
        .get("projectFileSyncEnabled")
        .and_then(Value::as_object)
        .and_then(|settings| {
            settings
                .get(project_id)
                .or_else(|| settings.get("default"))
                .and_then(Value::as_bool)
        });
    legacy_enabled.and_then(|enabled| {
        serde_json::from_value::<commands::file_sync::SourceWatchConfig>(
            json!({ "enabled": enabled }),
        )
        .ok()
    })
}
