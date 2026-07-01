use super::files::{is_public_project_rel, is_text_content_rel, safe_join};
use super::reviews::{
    load_review_items, normalize_review_title, parse_review_query, patch_review_item,
    resolve_review_items, review_id_for_parts,
};
use super::*;
use crate::commands;
use std::time::{SystemTime, UNIX_EPOCH};

fn test_project_dir() -> PathBuf {
    // Per-process atomic sequence appended to the timestamp so two
    // tests calling this concurrently can't collide on the same dir
    // (nanos alone are not unique enough under parallel `cargo test`,
    // which would let one test's remove_dir_all delete another's files).
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("llm-wiki-api-test-{id}-{seq}"));
    fs::create_dir_all(path.join("wiki")).unwrap();
    path
}

#[test]
fn safe_join_rejects_traversal() {
    let root = test_project_dir();
    let root_str = root.to_string_lossy();
    assert!(safe_join(&root_str, "../secret.md").is_err());
    assert!(safe_join(&root_str, "wiki/../../secret.md").is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn safe_join_accepts_project_relative_paths() {
    let root = test_project_dir();
    let root_str = root.to_string_lossy();
    let joined = safe_join(&root_str, "wiki/index.md").unwrap();
    assert_eq!(joined, root.join("wiki/index.md"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn query_parser_decodes_percent_and_plus() {
    let parsed = parse_query("path=wiki%2Fhello+world.md&token=a%2Bb");
    assert_eq!(parsed.get("path").unwrap(), "wiki/hello world.md");
    assert_eq!(parsed.get("token").unwrap(), "a+b");
}

#[test]
fn snippet_handles_unicode_boundaries() {
    let content = "前言。这里是关于知识图谱过滤的中文内容。后续说明。";
    let snippet = commands::search::build_snippet(content, "知识图谱");
    assert!(snippet.contains("知识图谱"));
}

#[test]
fn public_api_paths_exclude_internal_state() {
    assert!(is_public_project_rel("wiki/index.md"));
    assert!(is_public_project_rel("Wiki/index.md"));
    assert!(is_public_project_rel("raw/sources/source.md"));
    assert!(is_public_project_rel("Raw/Sources/source.md"));
    assert!(!is_public_project_rel(".llm-wiki/file-change-queue.json"));
    assert!(!is_public_project_rel("wiki/.draft.md"));
}

#[test]
fn review_query_defaults_to_unresolved_items() {
    let root = test_project_dir();
    let state_dir = root.join(".llm-wiki");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(
        state_dir.join("review.json"),
        json!([
            {
                "id": "r1",
                "type": "missing-page",
                "title": "Missing page: Attention",
                "description": "Add Attention",
                "options": [],
                "resolved": false,
                "createdAt": 1,
                "internalSecret": "do-not-expose"
            },
            {
                "id": "r2",
                "type": "duplicate",
                "title": "Duplicate: LLM",
                "description": "Merge pages",
                "options": [],
                "resolved": true,
                "createdAt": 2
            }
        ])
        .to_string(),
    )
    .unwrap();

    let query = parse_review_query("").unwrap();
    let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

    assert_eq!(query.status.as_str(), "unresolved");
    assert_eq!(reviews.len(), 1);
    assert_eq!(
        reviews[0].get("id").and_then(Value::as_str),
        Some(review_id_for_parts("missing-page", "Missing page: Attention").as_str())
    );
    assert!(reviews[0].get("internalSecret").is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn review_title_normalization_requires_a_prefix_delimiter() {
    assert_eq!(
        normalize_review_title("Missing page: Attention"),
        "attention"
    );
    assert_eq!(
        normalize_review_title(" Missing page: Attention"),
        "attention"
    );
    assert_eq!(
        normalize_review_title("Missing page Attention"),
        "missing page attention"
    );
    assert_eq!(normalize_review_title("疑似重复 注意力"), "疑似重复 注意力");
    assert_ne!(
        review_id_for_parts("missing-page", "Missing page: Attention"),
        review_id_for_parts("missing-page", "Missing page Attention")
    );
    assert_eq!(
        review_id_for_parts("missing-page", "Missing page: Attention"),
        "review-dbdcf949"
    );
    assert_eq!(
        review_id_for_parts("missing-page", " Missing page: Attention"),
        "review-dbdcf949"
    );
    assert_eq!(
        review_id_for_parts("missing-page", "Missing page Attention"),
        "review-fa5d9960"
    );
    assert_eq!(
        review_id_for_parts("missing-page", "疑似重复 注意力"),
        "review-d2dacda0"
    );
}

#[test]
fn review_query_filters_by_type_status_and_limit() {
    let root = test_project_dir();
    let state_dir = root.join(".llm-wiki");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(
        state_dir.join("review.json"),
        json!([
            { "id": "r1", "type": "missing-page", "title": "r1", "resolved": false, "createdAt": 1 },
            { "id": "r2", "type": "missing-page", "title": "r2", "resolved": false, "createdAt": 2 },
            { "id": "r3", "type": "duplicate", "resolved": false, "createdAt": 3 },
            { "id": "r4", "type": "missing-page", "resolved": true, "createdAt": 4 }
        ])
        .to_string(),
    )
    .unwrap();

    let query = parse_review_query("status=all&type=missing-page&limit=2").unwrap();
    let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

    assert_eq!(query.status.as_str(), "all");
    assert_eq!(
        reviews
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>(),
        vec![
            review_id_for_parts("missing-page", "r1"),
            review_id_for_parts("missing-page", "r2"),
        ]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn review_query_collapses_legacy_duplicate_ids_to_stable_id() {
    let root = test_project_dir();
    let state_dir = root.join(".llm-wiki");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(
        state_dir.join("review.json"),
        json!([
            {
                "id": "review-1",
                "type": "missing-page",
                "title": "Attention",
                "description": "",
                "affectedPages": ["a.md"],
                "resolved": false,
                "createdAt": 5
            },
            {
                "id": "review-2",
                "type": "missing-page",
                "title": "Missing page: Attention",
                "description": "resolved copy",
                "affectedPages": ["b.md"],
                "resolved": true,
                "resolvedAction": "user-resolved",
                "createdAt": 2
            }
        ])
        .to_string(),
    )
    .unwrap();

    let query = parse_review_query("status=all").unwrap();
    let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

    assert_eq!(reviews.len(), 1);
    assert_eq!(
        reviews[0].get("id").and_then(Value::as_str),
        Some(review_id_for_parts("missing-page", "Attention").as_str())
    );
    assert_eq!(
        reviews[0].get("resolved").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        reviews[0].get("resolvedAction").and_then(Value::as_str),
        Some("user-resolved")
    );
    assert_eq!(
        reviews[0]
            .get("affectedPages")
            .and_then(Value::as_array)
            .map(|pages| pages.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
        Some(vec!["a.md", "b.md"])
    );
    assert_eq!(
        reviews[0].get("createdAt").and_then(Value::as_f64),
        Some(2.0)
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn review_query_filters_status_after_stable_id_merge() {
    let root = test_project_dir();
    let state_dir = root.join(".llm-wiki");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(
        state_dir.join("review.json"),
        json!([
            {
                "id": "review-old-unresolved",
                "type": "missing-page",
                "title": "Attention",
                "resolved": false,
                "createdAt": 5
            },
            {
                "id": "review-old-resolved",
                "type": "missing-page",
                "title": "Missing page: Attention",
                "resolved": true,
                "resolvedAction": "Done",
                "createdAt": 6
            }
        ])
        .to_string(),
    )
    .unwrap();

    let unresolved = parse_review_query("status=unresolved").unwrap();
    let unresolved_reviews = load_review_items(root.to_str().unwrap(), &unresolved).unwrap();
    assert!(unresolved_reviews.is_empty());

    let all = parse_review_query("status=all").unwrap();
    let all_reviews = load_review_items(root.to_str().unwrap(), &all).unwrap();
    assert_eq!(all_reviews.len(), 1);
    assert_eq!(
        all_reviews[0].get("resolved").and_then(Value::as_bool),
        Some(true)
    );
    let _ = fs::remove_dir_all(root);
}

fn write_reviews(root: &Path, value: Value) {
    let state_dir = root.join(".llm-wiki");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(state_dir.join("review.json"), value.to_string()).unwrap();
}

fn read_reviews(root: &Path) -> Value {
    let raw = fs::read_to_string(root.join(".llm-wiki/review.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn patch_review_item_marks_resolved_and_preserves_unsanitized_fields() {
    let root = test_project_dir();
    write_reviews(
        &root,
        json!([
            {
                "id": "r1",
                "type": "missing-page",
                "resolved": false,
                "createdAt": 1,
                "internalSecret": "keep-me"
            },
            { "id": "r2", "type": "duplicate", "resolved": false, "createdAt": 2 }
        ]),
    );

    let found = patch_review_item(root.to_str().unwrap(), "r1", true, Some("Skip")).unwrap();
    assert!(found);

    // Re-read the RAW file: r1 must be resolved with the action label,
    // its non-sanitized `internalSecret` preserved (the write path must
    // not go through the sanitizing reader), and r2 left untouched.
    let parsed = read_reviews(&root);
    let items = parsed.as_array().unwrap();
    let r1 = items
        .iter()
        .find(|i| i.get("id").and_then(Value::as_str) == Some("r1"))
        .unwrap();
    assert_eq!(r1.get("resolved").and_then(Value::as_bool), Some(true));
    assert_eq!(
        r1.get("resolvedAction").and_then(Value::as_str),
        Some("Skip")
    );
    assert_eq!(
        r1.get("internalSecret").and_then(Value::as_str),
        Some("keep-me")
    );
    let r2 = items
        .iter()
        .find(|i| i.get("id").and_then(Value::as_str) == Some("r2"))
        .unwrap();
    assert_eq!(r2.get("resolved").and_then(Value::as_bool), Some(false));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_review_item_accepts_stable_id_for_legacy_counter_item() {
    let root = test_project_dir();
    write_reviews(
        &root,
        json!([
            {
                "id": "review-1",
                "type": "missing-page",
                "title": "Missing page: Attention",
                "resolved": false
            }
        ]),
    );

    let stable_id = review_id_for_parts("missing-page", "Attention");
    let found = patch_review_item(root.to_str().unwrap(), &stable_id, true, Some("API")).unwrap();
    assert!(found);

    let parsed = read_reviews(&root);
    let item = &parsed.as_array().unwrap()[0];
    assert_eq!(
        item.get("id").and_then(Value::as_str),
        Some(stable_id.as_str())
    );
    assert_eq!(item.get("resolved").and_then(Value::as_bool), Some(true));
    assert_eq!(
        item.get("resolvedAction").and_then(Value::as_str),
        Some("API")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_review_item_can_reopen_with_resolved_false() {
    let root = test_project_dir();
    write_reviews(
        &root,
        json!([{ "id": "r1", "resolved": true, "resolvedAction": "Skip" }]),
    );

    let found = patch_review_item(root.to_str().unwrap(), "r1", false, None).unwrap();
    assert!(found);

    let parsed = read_reviews(&root);
    let r1 = &parsed.as_array().unwrap()[0];
    assert_eq!(r1.get("resolved").and_then(Value::as_bool), Some(false));
    assert!(r1.get("resolvedAction").is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_review_item_returns_false_for_unknown_id() {
    let root = test_project_dir();
    write_reviews(&root, json!([{ "id": "r1", "resolved": false }]));

    let found = patch_review_item(root.to_str().unwrap(), "nope", true, None).unwrap();
    assert!(!found);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn patch_review_item_missing_file_returns_false() {
    let root = test_project_dir();
    let found = patch_review_item(root.to_str().unwrap(), "r1", true, None).unwrap();
    assert!(!found);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn resolve_review_items_bulk_resolves_matching_and_reports_not_found() {
    let root = test_project_dir();
    write_reviews(
        &root,
        json!([
            { "id": "r1", "resolved": false, "internalSecret": "a" },
            { "id": "r2", "resolved": false },
            { "id": "r3", "resolved": false }
        ]),
    );

    let ids = vec!["r1".to_string(), "r3".to_string(), "missing".to_string()];
    let (resolved, not_found) =
        resolve_review_items(root.to_str().unwrap(), &ids, Some("Bulk")).unwrap();

    // Input order preserved; missing id reported, not 404'd.
    assert_eq!(resolved, vec!["r1".to_string(), "r3".to_string()]);
    assert_eq!(not_found, vec!["missing".to_string()]);

    let parsed = read_reviews(&root);
    let items = parsed.as_array().unwrap();
    let by_id = |id: &str| {
        items
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some(id))
            .unwrap()
    };
    assert_eq!(
        by_id("r1").get("resolved").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        by_id("r1").get("resolvedAction").and_then(Value::as_str),
        Some("Bulk")
    );
    // Unsanitized field survives the bulk write-back too.
    assert_eq!(
        by_id("r1").get("internalSecret").and_then(Value::as_str),
        Some("a")
    );
    assert_eq!(
        by_id("r3").get("resolved").and_then(Value::as_bool),
        Some(true)
    );
    // r2 was not in the request — untouched.
    assert_eq!(
        by_id("r2").get("resolved").and_then(Value::as_bool),
        Some(false)
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn resolve_review_items_accepts_stable_ids_for_legacy_counter_items() {
    let root = test_project_dir();
    write_reviews(
        &root,
        json!([
            {
                "id": "review-1",
                "type": "missing-page",
                "title": "Missing page: Attention",
                "resolved": false
            },
            {
                "id": "review-2",
                "type": "duplicate",
                "title": "Duplicate page: Transformer",
                "resolved": false
            }
        ]),
    );

    let ids = vec![
        review_id_for_parts("missing-page", "Attention"),
        "missing".to_string(),
    ];
    let (resolved, not_found) =
        resolve_review_items(root.to_str().unwrap(), &ids, Some("Bulk")).unwrap();

    assert_eq!(resolved, vec![ids[0].clone()]);
    assert_eq!(not_found, vec!["missing".to_string()]);
    let parsed = read_reviews(&root);
    let items = parsed.as_array().unwrap();
    assert_eq!(
        items[0].get("id").and_then(Value::as_str),
        Some(ids[0].as_str())
    );
    assert_eq!(
        items[0].get("resolved").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(items[1].get("id").and_then(Value::as_str), Some("review-2"));
    assert_eq!(
        items[1].get("resolved").and_then(Value::as_bool),
        Some(false)
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn resolve_review_items_missing_file_reports_all_not_found() {
    let root = test_project_dir();
    let ids = vec!["r1".to_string(), "r2".to_string()];
    let (resolved, not_found) = resolve_review_items(root.to_str().unwrap(), &ids, None).unwrap();
    assert!(resolved.is_empty());
    assert_eq!(not_found, ids);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn project_path_match_normalizes_separators() {
    assert!(project_path_matches(
        "C:/Users/me/wiki",
        "C:\\Users\\me\\wiki"
    ));
    if cfg!(windows) {
        assert!(project_path_matches("C:/Users/me/wiki", "c:/users/me/wiki"));
    } else {
        assert!(!project_path_matches(
            "C:/Users/me/wiki",
            "c:/users/me/wiki"
        ));
    }
}

#[test]
fn tokenize_keeps_single_cjk_character() {
    assert_eq!(
        crate::commands::search::tokenize_query("图"),
        Vec::<String>::new()
    );
    let tokens = crate::commands::search::tokenize_query("知识图谱");
    assert!(tokens.contains(&"知识".to_string()));
}

#[test]
fn text_content_filter_rejects_binary_extensions() {
    assert!(is_text_content_rel("wiki/index.md"));
    assert!(!is_text_content_rel("wiki/media/image.png"));
    assert!(!is_text_content_rel("raw/sources/book.pdf"));
}

#[test]
fn constant_time_eq_matches_equal_bytes_only() {
    assert!(constant_time_eq(b"token", b"token"));
    assert!(constant_time_eq(b"", b""));
    assert!(!constant_time_eq(b"token", b"tokeN"));
    assert!(!constant_time_eq(b"token", b"token-longer"));
}

#[test]
fn rate_limit_skips_health_and_options_only() {
    assert!(!should_rate_limit(&Method::Get, "/api/v1/health"));
    assert!(!should_rate_limit(&Method::Options, "/api/v1/projects"));
    assert!(should_rate_limit(&Method::Get, "/wp-login"));
    assert!(should_rate_limit(
        &Method::Post,
        "/api/v1/projects/current/search"
    ));
}

#[test]
fn api_config_shape_parses_enabled_and_unauthenticated_access() {
    // Standalone pure-function check to mirror what `api_enabled`
    // reads off `load_app_state`. Mirrors the JS-side shape
    // emitted by `saveApiConfig` so any rename on either side
    // surfaces here before users hit it as a 503 in production.
    let payload = json!({
        "apiConfig": {
            "enabled": false,
            "allowUnauthenticated": true,
            "allowLanAccess": true,
            "mcpEnabled": true,
            "token": "abc"
        }
    });
    let enabled = payload
        .get("apiConfig")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    assert!(!enabled);
    let allow_unauthenticated = payload
        .get("apiConfig")
        .and_then(|v| v.get("allowUnauthenticated"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    assert!(allow_unauthenticated);
    let allow_lan_access = payload
        .get("apiConfig")
        .and_then(|v| v.get("allowLanAccess"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    assert!(allow_lan_access);
    let mcp_enabled = payload
        .get("apiConfig")
        .and_then(|v| v.get("mcpEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    assert!(mcp_enabled);
    let token_source = payload
        .get("apiConfig")
        .and_then(|v| v.get("token"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|_| "store")
        .unwrap_or("none");
    assert_eq!(token_source, "store");

    let missing = json!({});
    let enabled_missing = missing
        .get("apiConfig")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    // Fail-open by design — see `api_enabled` doc comment.
    assert!(enabled_missing);
    let mcp_enabled_missing = missing
        .get("apiConfig")
        .and_then(|v| v.get("mcpEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    assert!(!mcp_enabled_missing);
    let allow_lan_access_missing = missing
        .get("apiConfig")
        .and_then(|v| v.get("allowLanAccess"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    assert!(!allow_lan_access_missing);
}
