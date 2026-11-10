// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // MCP server for AI tools: stdio only, before anything Tauri starts.
    if std::env::args().any(|a| a == "--mcp") {
        return taskx_lib::mcp::run();
    }
    taskx_lib::run()
}
