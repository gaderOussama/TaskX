use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const VERSION: u64 = 3;

pub fn empty_doc() -> Value {
    json!({ "version": VERSION, "projects": [], "inbox": [] })
}

/// Same file the app has always used, so the existing projects are not migrated
/// or moved. `TASKX_DATA` exists so tests never touch the real one.
pub fn data_path() -> PathBuf {
    if let Ok(path) = std::env::var("TASKX_DATA") {
        return PathBuf::from(path);
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("taskx").join("data.json")
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", path.display(), suffix))
}

// v1 kept one `last` string per project. Fold it into the log, never drop it.
// v3 only adds optional fields (inbox, note, area, ideas, settings): a v2 file
// just gains an empty inbox, everything else is left as it was.
pub fn migrate(mut doc: Value) -> Value {
    if !doc.get("inbox").map(|i| i.is_array()).unwrap_or(false) {
        doc["inbox"] = json!([]);
    }
    if let Some(list) = doc.get_mut("projects").and_then(|p| p.as_array_mut()) {
        for p in list.iter_mut() {
            let Some(obj) = p.as_object_mut() else { continue };
            if !obj.get("entries").map(|e| e.is_array()).unwrap_or(false) {
                obj.insert("entries".to_string(), json!([]));
            }
            let last = obj
                .get("last")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(text) = last {
                if !text.trim().is_empty() {
                    let at = obj
                        .get("updatedAt")
                        .and_then(|v| v.as_u64())
                        .filter(|n| *n != 0)
                        .unwrap_or_else(now_ms);
                    if let Some(entries) = obj.get_mut("entries").and_then(|e| e.as_array_mut()) {
                        entries.push(json!({ "at": at, "text": text }));
                    }
                }
            }
            obj.remove("last");
        }
    }
    doc["version"] = json!(VERSION);
    doc
}

fn parsed(raw: &[u8]) -> Option<Value> {
    // Editors on Windows may prepend a BOM; it is not JSON.
    let text = String::from_utf8_lossy(raw);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str::<Value>(text).ok()
}

fn is_doc(doc: &Value) -> bool {
    doc.get("projects").map(|p| p.is_array()).unwrap_or(false)
}

// Quarantine first: the next save would rename an empty doc over the unreadable one.
fn quarantine(path: &Path) {
    let _ = fs::copy(path, with_suffix(path, ".corrupt.bak"));
}

pub fn load(path: &Path) -> Value {
    let Ok(bytes) = fs::read(path) else {
        return empty_doc();
    };
    match parsed(&bytes) {
        Some(doc) if is_doc(&doc) => migrate(doc),
        _ => {
            quarantine(path);
            empty_doc()
        }
    }
}

pub fn save(path: &Path, doc: &Value) -> Result<(), String> {
    if !is_doc(doc) {
        return Err("save(doc): doc.projects must be an array".to_string());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // One-step undo: keep the previous good file, so a bad edit is never the only copy.
    if fs::read(path).ok().and_then(|b| parsed(&b)).is_some() {
        let _ = fs::copy(path, with_suffix(path, ".bak"));
    }
    let tmp = with_suffix(path, ".tmp");
    let body = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The file's mtime in ms, 0 when missing. The renderer polls it to notice
/// writes made by the MCP server.
pub fn stamp(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static SEQ: AtomicU64 = AtomicU64::new(0);

fn new_id() -> String {
    format!("{:x}-{:x}", now_ms(), SEQ.fetch_add(1, Ordering::SeqCst))
}

fn push(target: &mut Value, key: &str, item: Value) {
    if !target[key].is_array() {
        target[key] = json!([]);
    }
    target[key].as_array_mut().unwrap().push(item);
}

/// By id, or by name ignoring case and surrounding spaces.
pub fn find_project<'a>(doc: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    let key = key.trim();
    let lower = key.to_lowercase();
    doc.get_mut("projects")?.as_array_mut()?.iter_mut().find(|p| {
        p["id"].as_str() == Some(key)
            || p["name"].as_str().map(|n| n.trim().to_lowercase() == lower).unwrap_or(false)
    })
}

/// Record what was just done, next to the next step it was done under.
pub fn add_log(doc: &mut Value, project: &str, text: &str) -> Option<()> {
    let p = find_project(doc, project)?;
    let at = now_ms();
    let next = p["next"].as_str().unwrap_or("").trim().to_string();
    push(p, "entries", json!({ "at": at, "text": text.trim(), "next": next }));
    p["updatedAt"] = json!(at);
    Some(())
}

/// A replaced next step is kept as an idea: nothing is ever lost.
pub fn set_next(doc: &mut Value, project: &str, text: &str) -> Option<()> {
    let p = find_project(doc, project)?;
    let at = now_ms();
    let old = p["next"].as_str().unwrap_or("").trim().to_string();
    let new = text.trim();
    if !old.is_empty() && old != new {
        push(p, "ideas", json!({ "id": new_id(), "at": at, "text": old }));
    }
    p["next"] = json!(new);
    p["updatedAt"] = json!(at);
    Some(())
}

pub fn add_idea(doc: &mut Value, project: &str, text: &str) -> Option<()> {
    let p = find_project(doc, project)?;
    push(p, "ideas", json!({ "id": new_id(), "at": now_ms(), "text": text.trim() }));
    Some(())
}

pub fn capture(doc: &mut Value, text: &str) {
    push(doc, "inbox", json!({ "id": new_id(), "at": now_ms(), "text": text.trim() }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn tmp_file() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("taskx-test-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        dir.join("data.json")
    }

    fn project(id: &str, priority: i64) -> Value {
        json!({ "id": id, "name": id, "priority": priority, "entries": [], "next": "", "updatedAt": 0 })
    }

    #[test]
    fn load_returns_empty_doc_when_missing() {
        assert_eq!(load(&tmp_file()), empty_doc());
    }

    #[test]
    fn save_then_load_round_trips() {
        let file = tmp_file();
        let doc = json!({ "version": 3, "projects": [project("a", 0), project("b", 1)], "inbox": [{ "id": "x", "at": 1, "text": "t" }], "settings": { "whisper": true } });
        save(&file, &doc).unwrap();
        assert_eq!(load(&file), doc);
    }

    #[test]
    fn save_leaves_no_tmp_file() {
        let file = tmp_file();
        save(&file, &empty_doc()).unwrap();
        assert!(!with_suffix(&file, ".tmp").exists());
        assert!(file.exists());
    }

    #[test]
    fn save_rejects_a_doc_without_projects() {
        let file = tmp_file();
        assert!(save(&file, &json!(null)).is_err());
        assert!(save(&file, &json!({ "version": 2 })).is_err());
        assert!(!file.exists());
    }

    #[test]
    fn load_returns_empty_for_corrupt_json() {
        let file = tmp_file();
        fs::write(&file, "{ not json").unwrap();
        assert_eq!(load(&file), empty_doc());
    }

    #[test]
    fn load_quarantines_corrupt_before_overwrite() {
        let file = tmp_file();
        fs::write(&file, "{ not json").unwrap();
        load(&file);
        let bak = with_suffix(&file, ".corrupt.bak");
        assert_eq!(fs::read_to_string(&bak).unwrap(), "{ not json");
    }

    #[test]
    fn load_returns_empty_for_wrong_shape() {
        let file = tmp_file();
        fs::write(&file, "{\"projects\":\"x\"}").unwrap();
        assert_eq!(load(&file), empty_doc());
        assert_eq!(
            fs::read_to_string(with_suffix(&file, ".corrupt.bak")).unwrap(),
            "{\"projects\":\"x\"}"
        );
    }

    #[test]
    fn v1_last_becomes_first_entry() {
        let file = tmp_file();
        fs::write(
            &file,
            json!({
                "version": 1,
                "projects": [{ "id": "a", "name": "Alpha", "priority": 0, "last": "fixed the parser", "next": "ship it", "updatedAt": 42 }]
            })
            .to_string(),
        )
        .unwrap();
        let doc = load(&file);
        assert_eq!(doc["version"], json!(3));
        assert_eq!(
            doc["projects"][0]["entries"],
            json!([{ "at": 42, "text": "fixed the parser" }])
        );
        assert!(doc["projects"][0].get("last").is_none());
        assert_eq!(doc["projects"][0]["next"], json!("ship it"));
    }

    #[test]
    fn migrating_twice_does_not_duplicate() {
        let file = tmp_file();
        fs::write(
            &file,
            json!({ "version": 1, "projects": [{ "id": "a", "name": "Alpha", "priority": 0, "last": "only once" }] })
                .to_string(),
        )
        .unwrap();
        load(&file);
        let second = load(&file);
        save(&file, &second).unwrap();
        assert_eq!(load(&file)["projects"][0]["entries"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn entries_survive_in_order() {
        let file = tmp_file();
        let entries = json!([
            { "at": 1, "text": "first" },
            { "at": 2, "text": "second" },
            { "at": 3, "text": "third" }
        ]);
        let mut p = project("a", 0);
        p["entries"] = entries.clone();
        save(&file, &json!({ "version": 2, "projects": [p] })).unwrap();
        assert_eq!(load(&file)["projects"][0]["entries"], entries);
    }

    #[test]
    fn non_ascii_survives() {
        let file = tmp_file();
        let p = json!({
            "id": "a", "name": "مشروع", "priority": 0,
            "next": "🚀 ship it", "updatedAt": 0,
            "entries": [{ "at": 1, "text": "naïve café" }]
        });
        save(&file, &json!({ "version": 2, "projects": [p.clone()] })).unwrap();
        assert_eq!(load(&file)["projects"][0], p);
    }

    #[test]
    fn bom_is_not_corruption() {
        let file = tmp_file();
        let doc = json!({ "version": 2, "projects": [project("a", 0)] });
        fs::write(&file, format!("\u{feff}{}", doc)).unwrap();
        assert_eq!(load(&file)["projects"][0]["id"], json!("a"));
        assert!(!with_suffix(&file, ".corrupt.bak").exists());
    }

    #[test]
    fn save_keeps_previous_file_as_bak() {
        let file = tmp_file();
        save(&file, &json!({ "version": 2, "projects": [project("first", 0)] })).unwrap();
        save(&file, &json!({ "version": 2, "projects": [project("second", 0)] })).unwrap();
        let now: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        let bak: Value =
            serde_json::from_str(&fs::read_to_string(with_suffix(&file, ".bak")).unwrap()).unwrap();
        assert_eq!(now["projects"][0]["id"], json!("second"));
        assert_eq!(bak["projects"][0]["id"], json!("first"));
    }

    #[test]
    fn save_writes_no_bak_when_nothing_to_back_up() {
        let file = tmp_file();
        save(&file, &empty_doc()).unwrap();
        assert!(!with_suffix(&file, ".bak").exists());
    }

    #[test]
    fn save_never_overwrites_good_bak_with_corrupt() {
        let file = tmp_file();
        save(&file, &json!({ "version": 2, "projects": [project("good", 0)] })).unwrap();
        save(&file, &json!({ "version": 2, "projects": [project("newer", 0)] })).unwrap();
        fs::write(&file, "{ broken").unwrap();
        save(&file, &json!({ "version": 2, "projects": [project("after", 0)] })).unwrap();
        let bak: Value =
            serde_json::from_str(&fs::read_to_string(with_suffix(&file, ".bak")).unwrap()).unwrap();
        assert_eq!(bak["projects"][0]["id"], json!("good"));
    }

    #[test]
    fn v2_file_loads_intact_and_gains_inbox() {
        let file = tmp_file();
        let p = json!({
            "id": "a", "name": "Alpha", "priority": 2, "star": true, "next": "ship it", "updatedAt": 9,
            "entries": [{ "at": 1, "text": "one", "next": "two" }]
        });
        fs::write(&file, json!({ "version": 2, "projects": [p.clone()] }).to_string()).unwrap();
        let doc = load(&file);
        assert_eq!(doc["version"], json!(3));
        assert_eq!(doc["inbox"], json!([]));
        assert_eq!(doc["projects"][0], p);
        save(&file, &doc).unwrap();
        assert_eq!(load(&file), doc);
    }

    #[test]
    fn migrate_keeps_an_existing_inbox() {
        let inbox = json!([{ "id": "x", "at": 1, "text": "keep" }]);
        let doc = migrate(json!({ "version": 3, "projects": [], "inbox": inbox.clone() }));
        assert_eq!(doc["inbox"], inbox);
    }

    #[test]
    fn find_by_id_or_trimmed_case_insensitive_name() {
        let mut doc = json!({ "projects": [project("a", 0), { "id": "b", "name": "Big Thing" }] });
        assert_eq!(find_project(&mut doc, "a").unwrap()["id"], json!("a"));
        assert_eq!(find_project(&mut doc, "  big THING ").unwrap()["id"], json!("b"));
        assert!(find_project(&mut doc, "nope").is_none());
    }

    #[test]
    fn add_log_records_current_next() {
        let mut doc = json!({ "projects": [{ "id": "a", "name": "A", "next": " go ", "entries": [], "updatedAt": 0 }] });
        add_log(&mut doc, "A", " did it ").unwrap();
        let p = &doc["projects"][0];
        assert_eq!(p["entries"][0]["text"], json!("did it"));
        assert_eq!(p["entries"][0]["next"], json!("go"));
        assert!(p["updatedAt"].as_u64().unwrap() > 0);
        assert!(add_log(&mut doc, "zzz", "x").is_none());
    }

    #[test]
    fn set_next_keeps_the_old_one_as_an_idea() {
        let mut doc = json!({ "projects": [{ "id": "a", "name": "A", "next": "old", "entries": [] }] });
        set_next(&mut doc, "a", "new").unwrap();
        set_next(&mut doc, "a", "new").unwrap(); // same text: no duplicate idea
        let p = &doc["projects"][0];
        assert_eq!(p["next"], json!("new"));
        assert_eq!(p["ideas"].as_array().unwrap().len(), 1);
        assert_eq!(p["ideas"][0]["text"], json!("old"));
    }

    #[test]
    fn ideas_and_capture_get_unique_ids() {
        let mut doc = json!({ "projects": [{ "id": "a", "name": "A" }] });
        add_idea(&mut doc, "a", "i1").unwrap();
        add_idea(&mut doc, "a", "i2").unwrap();
        capture(&mut doc, " c ");
        let ideas = doc["projects"][0]["ideas"].as_array().unwrap();
        assert_ne!(ideas[0]["id"], ideas[1]["id"]);
        assert_eq!(doc["inbox"][0]["text"], json!("c"));
    }

    #[test]
    fn stamp_is_zero_when_missing_and_set_after_save() {
        let file = tmp_file();
        assert_eq!(stamp(&file), 0);
        save(&file, &empty_doc()).unwrap();
        assert!(stamp(&file) > 0);
    }
}
