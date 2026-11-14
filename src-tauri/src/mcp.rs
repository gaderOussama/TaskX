//! A tiny MCP server over stdio (`taskx.exe --mcp`), so AI tools can read and
//! write the same data file the panel uses. Newline-delimited JSON-RPC 2.0:
//! one request per stdin line, one reply per stdout line. Nothing else may ever
//! reach stdout, so diagnostics go to stderr.

use crate::store;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;

pub fn run() {
    let path = store::data_path();
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = handle(&line, &path) {
            if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
}

/// One request line in, one reply line out. A message without an `id` is a
/// notification and gets no reply.
pub fn handle(line: &str, path: &Path) -> Option<String> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Some(reply(Value::Null, Err((-32700, "parse error".into())))),
    };
    let id = msg.get("id")?.clone();
    let params = &msg["params"];
    let result = match msg["method"].as_str().unwrap_or("") {
        "initialize" => Ok(json!({
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "taskx", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call(params, path)),
        other => Err((-32601, format!("method not found: {other}"))),
    };
    Some(reply(id, result))
}

fn reply(id: Value, result: Result<Value, (i32, String)>) -> String {
    match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    }
    .to_string()
}

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required },
    })
}

fn tools() -> Value {
    let project = json!({ "type": "string", "description": "Project name (case-insensitive) or id" });
    let text = |what: &str| json!({ "type": "string", "description": what });
    json!([
        tool(
            "list_projects",
            "List every project with its area, next step, last log entry, days since that entry, and the inbox count.",
            json!({}),
            &[],
        ),
        tool(
            "get_project",
            "Get one project's pinned note, area, next step, ideas and its most recent log entries.",
            json!({
                "project": project,
                "entries": { "type": "number", "description": "How many recent log entries to return (default 10)" },
            }),
            &["project"],
        ),
        tool(
            "add_log",
            "Record what was just done on a project.",
            json!({ "project": project, "text": text("What was done") }),
            &["project", "text"],
        ),
        tool(
            "set_next",
            "Set the one next step of a project; the previous next step is kept as an idea.",
            json!({ "project": project, "text": text("The next step") }),
            &["project", "text"],
        ),
        tool(
            "add_idea",
            "Add an idea to a project's idea list.",
            json!({ "project": project, "text": text("The idea") }),
            &["project", "text"],
        ),
        tool(
            "capture",
            "Capture a loose thought into the inbox, to be sorted into a project later.",
            json!({ "text": text("The thought") }),
            &["text"],
        ),
    ])
}

fn call(params: &Value, path: &Path) -> Value {
    let (text, error) = match run_tool(params["name"].as_str().unwrap_or(""), &params["arguments"], path) {
        Ok(text) => (text, false),
        Err(text) => (text, true),
    };
    let mut result = json!({ "content": [{ "type": "text", "text": text }] });
    if error {
        result["isError"] = json!(true);
    }
    result
}

/// A required, non-blank string argument.
fn arg(args: &Value, key: &str) -> Result<String, String> {
    args[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| format!("missing required argument '{key}'"))
}

fn run_tool(name: &str, args: &Value, path: &Path) -> Result<String, String> {
    // Fresh every call: the panel may have written since the last one.
    let mut doc = store::load(path);
    match name {
        "list_projects" => Ok(pretty(&list(&doc))),
        "capture" => {
            store::capture(&mut doc, &arg(args, "text")?);
            store::save(path, &doc)?;
            Ok("Captured to the inbox.".into())
        }
        "get_project" | "add_log" | "set_next" | "add_idea" => {
            let key = arg(args, "project")?;
            let Some(p) = store::find_project(&mut doc, &key) else {
                return Err(unknown(&doc, &key));
            };
            if name == "get_project" {
                let n = args["entries"].as_u64().unwrap_or(10) as usize;
                return Ok(pretty(&detail(p, n)));
            }
            let pname = p["name"].as_str().unwrap_or("").to_string();
            let text = arg(args, "text")?;
            let (done, what) = match name {
                "add_log" => (store::add_log(&mut doc, &key, &text), "Logged to"),
                "set_next" => (store::set_next(&mut doc, &key, &text), "Next step set on"),
                _ => (store::add_idea(&mut doc, &key, &text), "Idea added to"),
            };
            done.ok_or_else(|| unknown(&doc, &key))?;
            store::save(path, &doc)?;
            Ok(format!("{what} {pname}."))
        }
        other => Err(format!("unknown tool '{other}'")),
    }
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn unknown(doc: &Value, key: &str) -> String {
    let names: Vec<&str> = doc["projects"]
        .as_array()
        .map(|a| a.iter().filter_map(|p| p["name"].as_str()).collect())
        .unwrap_or_default();
    format!("Unknown project '{key}'. Valid projects: {}", names.join(", "))
}

fn list(doc: &Value) -> Value {
    let now = store::now_ms();
    let rows: Vec<Value> = doc["projects"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|p| {
            let last = p["entries"].as_array().and_then(|e| e.last());
            let at = last.and_then(|e| e["at"].as_u64());
            json!({
                "name": p["name"],
                "area": p["area"],
                "star": p["star"].as_bool().unwrap_or(false),
                "next": p["next"],
                "lastEntry": last.map(|e| e["text"].clone()),
                "lastEntryDate": at.map(date),
                "daysSinceLastEntry": at.map(|a| now.saturating_sub(a) / 86_400_000),
            })
        })
        .collect();
    json!({ "projects": rows, "inboxCount": doc["inbox"].as_array().map(Vec::len).unwrap_or(0) })
}

fn detail(p: &Value, n: usize) -> Value {
    let dated = |e: &Value| {
        let mut e = e.clone();
        e["date"] = json!(date(e["at"].as_u64().unwrap_or(0)));
        e
    };
    let entries = p["entries"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let ideas = p["ideas"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    json!({
        "name": p["name"],
        "area": p["area"],
        "note": p["note"],
        "next": p["next"],
        "ideas": ideas.iter().map(dated).collect::<Vec<_>>(),
        "entries": entries[entries.len().saturating_sub(n)..].iter().map(dated).collect::<Vec<_>>(),
    })
}

/// `YYYY-MM-DD` (UTC) from epoch ms; civil-from-days, so no date crate.
fn date(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + (m <= 2) as i64;
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    fn seeded() -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("taskx-mcp-{}-{}", std::process::id(), n));
        let file = dir.join("data.json");
        let doc = json!({ "version": 3, "inbox": [], "projects": [
            { "id": "a", "name": "Alpha", "priority": 0, "entries": [], "next": "ship", "updatedAt": 0 },
            { "id": "b", "name": "Beta", "priority": 1, "entries": [], "next": "", "updatedAt": 0 }
        ] });
        store::save(&file, &doc).unwrap();
        file
    }

    fn rpc(path: &Path, method: &str, params: Value) -> Value {
        let line = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        serde_json::from_str(&handle(&line, path).unwrap()).unwrap()
    }

    fn tool_call(path: &Path, name: &str, args: Value) -> Value {
        rpc(path, "tools/call", json!({ "name": name, "arguments": args }))["result"].clone()
    }

    fn text(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn initialize_echoes_the_protocol_version() {
        let r = rpc(&seeded(), "initialize", json!({ "protocolVersion": "2024-11-05" }));
        assert_eq!(r["result"]["protocolVersion"], json!("2024-11-05"));
        assert_eq!(r["result"]["serverInfo"]["name"], json!("taskx"));
        assert!(r["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn tools_list_has_six_tools_with_schemas() {
        let r = rpc(&seeded(), "tools/list", json!({}));
        let tools = r["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 6);
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == json!("object")));
    }

    #[test]
    fn add_log_then_get_project_round_trips() {
        let path = seeded();
        let r = tool_call(&path, "add_log", json!({ "project": "alpha", "text": "wrote the parser" }));
        assert!(r.get("isError").is_none(), "{r}");
        let got: Value = serde_json::from_str(&text(&tool_call(&path, "get_project", json!({ "project": "Alpha" })))).unwrap();
        assert_eq!(got["entries"][0]["text"], json!("wrote the parser"));
        assert_eq!(got["entries"][0]["next"], json!("ship"));
        assert_eq!(got["entries"][0]["date"].as_str().unwrap().len(), 10);
        // The app's own loader sees the same write.
        assert_eq!(store::load(&path)["projects"][0]["entries"][0]["text"], json!("wrote the parser"));
    }

    #[test]
    fn set_next_keeps_the_old_one_and_capture_fills_the_inbox() {
        let path = seeded();
        tool_call(&path, "set_next", json!({ "project": "a", "text": "test it" }));
        tool_call(&path, "capture", json!({ "text": "buy milk" }));
        let doc = store::load(&path);
        assert_eq!(doc["projects"][0]["next"], json!("test it"));
        assert_eq!(doc["projects"][0]["ideas"][0]["text"], json!("ship"));
        assert_eq!(doc["inbox"][0]["text"], json!("buy milk"));
        let listed: Value = serde_json::from_str(&text(&tool_call(&path, "list_projects", json!({})))).unwrap();
        assert_eq!(listed["inboxCount"], json!(1));
        assert_eq!(listed["projects"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn notifications_get_no_reply() {
        let line = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
        assert!(handle(&line, &seeded()).is_none());
    }

    #[test]
    fn unknown_project_is_an_error_listing_valid_names() {
        let path = seeded();
        let r = tool_call(&path, "add_log", json!({ "project": "nope", "text": "x" }));
        assert_eq!(r["isError"], json!(true));
        assert!(text(&r).contains("Alpha, Beta"));
        assert_eq!(store::load(&path)["projects"][0]["entries"], json!([]));
    }

    #[test]
    fn unknown_method_is_32601() {
        assert_eq!(rpc(&seeded(), "nope", json!({}))["error"]["code"], json!(-32601));
    }

    #[test]
    fn dates_are_iso() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(1_700_000_000_000), "2023-11-14");
    }
}
