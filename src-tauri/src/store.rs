use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const VERSION: u64 = 2;

pub fn empty_doc() -> Value {
    json!({ "version": VERSION, "projects": [] })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", path.display(), suffix))
}

// v1 kept one `last` string per project. Fold it into the log, never drop it.
pub fn migrate(mut doc: Value) -> Value {
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

pub fn move_project(doc: &mut Value, id: &str, direction: &str) -> Result<(), String> {
    let projects = doc
        .get_mut("projects")
        .and_then(|p| p.as_array_mut())
        .ok_or("projects must be an array")?;

    let mut list = projects.clone();
    list.sort_by_key(|p| p.get("priority").and_then(|v| v.as_i64()).unwrap_or(0));

    if let Some(from) = list
        .iter()
        .position(|p| p.get("id").and_then(|v| v.as_str()) == Some(id))
    {
        let to = if direction == "up" {
            from as i64 - 1
        } else {
            from as i64 + 1
        };
        if to >= 0 && (to as usize) < list.len() {
            list.swap(from, to as usize);
        }
    }

    for (i, p) in list.iter_mut().enumerate() {
        if let Some(obj) = p.as_object_mut() {
            obj.insert("priority".to_string(), json!(i));
        }
    }
    *projects = list;
    Ok(())
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
        let doc = json!({ "version": 2, "projects": [project("a", 0), project("b", 1)] });
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
        assert_eq!(doc["version"], json!(2));
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

    fn ids_and_priorities(doc: &Value) -> Vec<(String, i64)> {
        doc["projects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["id"].as_str().unwrap().to_string(),
                    p["priority"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn move_up_renumbers() {
        let mut doc = json!({ "version": 2, "projects": [project("a", 0), project("b", 1), project("c", 2)] });
        move_project(&mut doc, "c", "up").unwrap();
        assert_eq!(
            ids_and_priorities(&doc),
            vec![
                ("a".to_string(), 0),
                ("c".to_string(), 1),
                ("b".to_string(), 2)
            ]
        );
    }

    #[test]
    fn move_past_the_top_is_a_noop() {
        let mut doc = json!({ "version": 2, "projects": [project("a", 0), project("b", 1)] });
        move_project(&mut doc, "a", "up").unwrap();
        assert_eq!(
            ids_and_priorities(&doc),
            vec![("a".to_string(), 0), ("b".to_string(), 1)]
        );
    }

    #[test]
    fn move_unknown_id_still_renumbers() {
        let mut doc = json!({ "version": 2, "projects": [project("a", 5), project("b", 9)] });
        move_project(&mut doc, "nope", "up").unwrap();
        assert_eq!(
            ids_and_priorities(&doc),
            vec![("a".to_string(), 0), ("b".to_string(), 1)]
        );
    }
}
