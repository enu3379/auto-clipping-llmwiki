use super::*;

pub(super) fn handle_files(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let root = params.get("root").map(String::as_str).unwrap_or("wiki");
    let recursive = params
        .get("recursive")
        .map(|v| v != "false")
        .unwrap_or(true);
    let max_files = params
        .get("maxFiles")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, HARD_MAX_FILES);
    let rel = match root {
        "wiki" => "wiki",
        "sources" | "raw" | "raw/sources" => "raw/sources",
        "all" | "" => "",
        _ => return err(400, "root must be wiki, sources, or all"),
    };
    if rel.is_empty() {
        return match list_public_roots(&project.path, recursive, max_files) {
            Ok(files) => ok(json!({
                "ok": true,
                "projectId": project.id,
                "root": "all",
                "files": files,
                "truncated": false,
            })),
            Err(e) => err(if e.contains("exceeds") { 413 } else { 500 }, e),
        };
    }
    let dir = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(e) => return err(400, e),
    };
    let mut count = 0;
    match list_tree(&project.path, &dir, recursive, max_files, &mut count) {
        Ok(files) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "root": rel,
            "files": files,
            "truncated": false,
        })),
        Err(e) => err(if e.contains("exceeds") { 413 } else { 500 }, e),
    }
}

pub(super) fn handle_file_content(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let Some(rel) = params.get("path") else {
        return err(400, "Missing path query parameter");
    };
    if !is_public_project_rel(rel) {
        return err(403, "Path is not exposed by the local API");
    }
    if !is_text_content_rel(rel) {
        return err(
            415,
            "Only text-like project files can be read via this endpoint",
        );
    }
    let path = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(e) => return err(400, e),
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) => return err(404, format!("File not found: {e}")),
    };
    if meta.len() > MAX_FILE_CONTENT_BYTES {
        return err(413, "File is too large to return via API");
    }
    match fs::read_to_string(&path) {
        Ok(content) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "path": rel,
            "content": content,
        })),
        Err(_) => err(415, "File is not valid UTF-8 text"),
    }
}

pub(super) fn safe_join(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_path);
    let rel = rel.trim_start_matches('/');
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    for component in rel_path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        ) {
            return Err("Path traversal is not allowed".to_string());
        }
    }
    let joined = root.join(rel_path);
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {e}"))?;
    if joined.exists() {
        let joined_canon = joined
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {e}"))?;
        if !joined_canon.starts_with(&root_canon) {
            return Err("Resolved path escapes the project directory".to_string());
        }
        return Ok(joined_canon);
    }
    let parent = joined
        .parent()
        .ok_or_else(|| "Path has no parent directory".to_string())?;
    if parent.exists() {
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("Failed to resolve parent path: {e}"))?;
        if !parent_canon.starts_with(&root_canon) {
            return Err("Resolved parent escapes the project directory".to_string());
        }
    }
    Ok(joined)
}

pub(super) fn is_public_project_rel(rel: &str) -> bool {
    let rel = normalize_path(rel).trim_start_matches('/').to_string();
    if rel
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return false;
    }
    let lower = rel.to_lowercase();
    lower == "purpose.md"
        || lower == "schema.md"
        || lower.starts_with("wiki/")
        || lower.starts_with("raw/sources/")
}

pub(super) fn is_text_content_rel(rel: &str) -> bool {
    let rel = normalize_path(rel).to_lowercase();
    let ext = Path::new(&rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    matches!(
        ext,
        "md" | "mdx"
            | "txt"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "rtf"
            | "log"
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiFileNode {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
    children: Option<Vec<ApiFileNode>>,
}

fn list_public_roots(
    project_path: &str,
    recursive: bool,
    max_files: usize,
) -> Result<Vec<ApiFileNode>, String> {
    let mut count = 0;
    let mut roots = Vec::new();
    for rel in ["purpose.md", "schema.md", "wiki", "raw/sources"] {
        let path = safe_join(project_path, rel)?;
        if !path.exists() {
            continue;
        }
        push_file_node(
            project_path,
            &path,
            recursive,
            max_files,
            &mut count,
            &mut roots,
        )?;
    }
    Ok(roots)
}

fn list_tree(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
) -> Result<Vec<ApiFileNode>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to list directory: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        push_file_node(
            project_path,
            &entry.path(),
            recursive,
            max_files,
            count,
            &mut out,
        )?;
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn push_file_node(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
    out: &mut Vec<ApiFileNode>,
) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if name.starts_with('.') {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Failed to read metadata: {e}"))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    *count += 1;
    if *count > max_files {
        return Err(format!("File listing exceeds maxFiles limit ({max_files})"));
    }
    let is_dir = file_type.is_dir();
    let children = if recursive && is_dir {
        Some(list_tree(project_path, path, true, max_files, count)?)
    } else {
        None
    };
    out.push(ApiFileNode {
        name,
        path: relative_to_project(project_path, path),
        is_dir,
        size: if is_dir { None } else { Some(meta.len()) },
        children,
    });
    Ok(())
}

pub(super) fn relative_to_project(project_path: &str, path: &Path) -> String {
    let root = Path::new(project_path);
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}
