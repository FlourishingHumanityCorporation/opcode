//! Transform Codex CLI `--json` JSONL output into Claude-compatible stream-json.
//!
//! Codex `exec --json` emits structured JSONL on stdout. This module parses those
//! events and transforms them into the `{ type: "assistant", message: { content: [...] } }`
//! format the frontend's StreamMessage component expects.
//!
//! Codex may output events in two formats:
//! - **Codex SDK format**: `item.completed`, `turn.completed`, `thread.started`, etc.
//! - **OpenAI Responses API format**: `response.output_text.delta`, `response.completed`, etc.
//! Both are handled; unknown events fall back to raw text wrapping.

use serde_json::{json, Value};

// ─── Transform logic ────────────────────────────────────────────────────────

/// Transform a single Codex JSONL line into Claude-compatible stream-json.
///
/// Returns `None` for events that should be skipped (e.g. `thread.started`).
/// Returns `Some(json_string)` for events that map to renderable messages.
/// Falls back to wrapping the raw line as generic text for unrecognized events.
pub fn transform_codex_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Try to parse as JSON
    let event: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            // Not JSON at all — wrap as generic text
            return Some(wrap_as_text(trimmed));
        }
    };

    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
    log::info!("codex event type: {}", event_type);

    match event_type {
        // ── Codex SDK format ────────────────────────────────────────────
        "thread.started" | "turn.started" => None,

        "item.completed" => transform_item_completed(&event),

        "turn.completed" => {
            let input_tokens = event
                .pointer("/usage/input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output_tokens = event
                .pointer("/usage/output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            Some(
                json!({
                    "type": "result",
                    "usage": {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    }
                })
                .to_string(),
            )
        }

        // ── OpenAI Responses API format ─────────────────────────────────
        // Streaming text delta — the most important event for rendering
        "response.output_text.delta" => {
            let delta = event.get("delta").and_then(|d| d.as_str()).unwrap_or("");
            if delta.is_empty() {
                return None;
            }
            Some(wrap_as_text(delta))
        }

        // Completed text — full text available
        "response.output_text.done" => {
            let text = event.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if text.is_empty() {
                return None;
            }
            Some(wrap_as_text(text))
        }

        // Completed output item — may contain message content
        "response.output_item.done" => {
            if let Some(item) = event.get("item") {
                // Try to extract text from item.content array
                if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                    let texts: Vec<&str> = content
                        .iter()
                        .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("output_text"))
                        .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                        .collect();
                    if !texts.is_empty() {
                        return Some(wrap_as_text(&texts.join("\n")));
                    }
                }
                // Try item.text directly
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        return Some(wrap_as_text(text));
                    }
                }
            }
            None
        }

        // Response completed — extract usage
        "response.completed" => {
            let input_tokens = event
                .pointer("/response/usage/input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output_tokens = event
                .pointer("/response/usage/output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if input_tokens > 0 || output_tokens > 0 {
                Some(
                    json!({
                        "type": "result",
                        "usage": {
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                        }
                    })
                    .to_string(),
                )
            } else {
                None
            }
        }

        // Skip non-content events
        "response.created" | "response.in_progress" | "response.output_item.added"
        | "response.content_part.added" | "response.content_part.done" => None,

        // ── Fallback for any unrecognized event ─────────────────────────
        _ => {
            // Try to extract ANY text from the event before giving up
            if let Some(text) = try_extract_text_from_value(&event) {
                log::info!(
                    "Extracted text from unknown codex event '{}': {}",
                    event_type,
                    &text[..text.len().min(100)]
                );
                Some(wrap_as_text(&text))
            } else {
                log::debug!("Skipping codex event with no extractable text: {}", event_type);
                None
            }
        }
    }
}

/// Transform a Codex SDK `item.completed` event.
fn transform_item_completed(event: &Value) -> Option<String> {
    let item = event.get("item")?;
    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match item_type {
        "agent_message" | "message" => {
            let text = extract_text_from_item(item);
            if text.is_empty() {
                return None;
            }
            Some(wrap_as_text(&text))
        }

        "reasoning" => {
            let text = extract_text_from_item(item);
            if text.is_empty() {
                return None;
            }
            Some(wrap_as_text(&format!("[thinking] {}", text)))
        }

        "command_execution" | "function_call" => {
            let cmd = item
                .get("command")
                .or_else(|| item.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let output = item
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let text = if output.is_empty() {
                format!("$ {}", cmd)
            } else {
                format!("$ {}\n{}", cmd, output)
            };
            Some(wrap_as_text(&text))
        }

        _ => {
            // Unknown item type — try to extract any text
            let text = extract_text_from_item(item);
            if text.is_empty() {
                None
            } else {
                Some(wrap_as_text(&text))
            }
        }
    }
}

/// Extract text from an item Value, checking `text`, `content` array, and `message` fields.
fn extract_text_from_item(item: &Value) -> String {
    // Direct text field
    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
        if !text.is_empty() {
            return text.to_string();
        }
    }

    // Content array (Claude/Codex format)
    if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
        let parts: Vec<&str> = content
            .iter()
            .filter(|c| {
                let t = c.get("type").and_then(|t| t.as_str()).unwrap_or("");
                t == "text" || t == "output_text"
            })
            .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
            .collect();
        if !parts.is_empty() {
            return parts.join("\n");
        }
    }

    // Message field (some formats nest content under message)
    if let Some(message) = item.get("message") {
        if let Some(text) = message.get("text").and_then(|t| t.as_str()) {
            return text.to_string();
        }
        if let Some(content) = message.get("content").and_then(|c| c.as_str()) {
            return content.to_string();
        }
    }

    String::new()
}

/// Try to find any text content in an arbitrary JSON value.
/// Used as a last resort for unknown event formats.
fn try_extract_text_from_value(value: &Value) -> Option<String> {
    // Check common text fields at top level
    for key in &["text", "delta", "content", "message", "output", "data"] {
        if let Some(s) = value.get(*key).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }

    // Check nested item
    if let Some(item) = value.get("item") {
        let text = extract_text_from_item(item);
        if !text.is_empty() {
            return Some(text);
        }
    }

    // Check nested response.output
    if let Some(response) = value.get("response") {
        if let Some(output) = response.get("output").and_then(|o| o.as_array()) {
            let mut combined = String::new();
            for item in output {
                if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                    for c in content {
                        if let Some(text) = c.get("text").and_then(|t| t.as_str()) {
                            if !combined.is_empty() {
                                combined.push('\n');
                            }
                            combined.push_str(text);
                        }
                    }
                }
            }
            if !combined.is_empty() {
                return Some(combined);
            }
        }
    }

    None
}

/// Wrap a text string in Claude assistant message format.
fn wrap_as_text(text: &str) -> String {
    json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": text}]
        }
    })
    .to_string()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Codex SDK format tests ──────────────────────────────────────────

    #[test]
    fn test_agent_message_with_text_field() {
        let line = r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hello world"}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(parsed["message"]["content"][0]["text"], "Hello world");
    }

    #[test]
    fn test_agent_message_with_content_array() {
        let line = r#"{"type":"item.completed","item":{"type":"agent_message","content":[{"type":"text","text":"from content"}]}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message"]["content"][0]["text"], "from content");
    }

    #[test]
    fn test_reasoning_item() {
        let line =
            r#"{"type":"item.completed","item":{"type":"reasoning","text":"I should check the file"}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["message"]["content"][0]["text"],
            "[thinking] I should check the file"
        );
    }

    #[test]
    fn test_command_execution() {
        let line = r#"{"type":"item.completed","item":{"type":"command_execution","command":"ls -la","output":"total 42\ndrwxr-xr-x"}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        let text = parsed["message"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("$ ls -la\n"));
        assert!(text.contains("total 42"));
    }

    #[test]
    fn test_command_execution_no_output() {
        let line = r#"{"type":"item.completed","item":{"type":"command_execution","command":"mkdir test","output":""}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message"]["content"][0]["text"], "$ mkdir test");
    }

    #[test]
    fn test_turn_completed_with_usage() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":150,"output_tokens":50}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "result");
        assert_eq!(parsed["usage"]["input_tokens"], 150);
        assert_eq!(parsed["usage"]["output_tokens"], 50);
    }

    #[test]
    fn test_thread_started_skipped() {
        let line = r#"{"type":"thread.started"}"#;
        assert!(transform_codex_line(line).is_none());
    }

    #[test]
    fn test_turn_started_skipped() {
        let line = r#"{"type":"turn.started"}"#;
        assert!(transform_codex_line(line).is_none());
    }

    // ── OpenAI Responses API format tests ───────────────────────────────

    #[test]
    fn test_response_output_text_delta() {
        let line = r#"{"type":"response.output_text.delta","delta":"Hello "}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(parsed["message"]["content"][0]["text"], "Hello ");
    }

    #[test]
    fn test_response_output_text_done() {
        let line = r#"{"type":"response.output_text.done","text":"Hello world"}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message"]["content"][0]["text"], "Hello world");
    }

    #[test]
    fn test_response_output_item_done() {
        let line = r#"{"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Result text"}]}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message"]["content"][0]["text"], "Result text");
    }

    #[test]
    fn test_response_completed_with_usage() {
        let line = r#"{"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":25}}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "result");
        assert_eq!(parsed["usage"]["input_tokens"], 100);
        assert_eq!(parsed["usage"]["output_tokens"], 25);
    }

    #[test]
    fn test_response_created_skipped() {
        let line = r#"{"type":"response.created","response":{"id":"resp_123"}}"#;
        assert!(transform_codex_line(line).is_none());
    }

    #[test]
    fn test_response_in_progress_skipped() {
        let line = r#"{"type":"response.in_progress"}"#;
        assert!(transform_codex_line(line).is_none());
    }

    // ── Fallback tests ──────────────────────────────────────────────────

    #[test]
    fn test_unknown_event_with_text_field_extracts() {
        let line = r#"{"type":"some.unknown.event","text":"Important message"}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message"]["content"][0]["text"], "Important message");
    }

    #[test]
    fn test_unknown_event_with_delta_field_extracts() {
        let line = r#"{"type":"some.unknown.event","delta":"delta text"}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message"]["content"][0]["text"], "delta text");
    }

    #[test]
    fn test_unknown_event_no_text_skipped() {
        let line = r#"{"type":"some.unknown.event","id":"xyz"}"#;
        assert!(transform_codex_line(line).is_none());
    }

    #[test]
    fn test_invalid_json_fallback() {
        let line = "This is just plain text output";
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(
            parsed["message"]["content"][0]["text"],
            "This is just plain text output"
        );
    }

    #[test]
    fn test_empty_line_skipped() {
        assert!(transform_codex_line("").is_none());
        assert!(transform_codex_line("   ").is_none());
    }

    #[test]
    fn test_empty_text_agent_message_skipped() {
        let line = r#"{"type":"item.completed","item":{"type":"agent_message","text":""}}"#;
        assert!(transform_codex_line(line).is_none());
    }

    #[test]
    fn test_empty_delta_skipped() {
        let line = r#"{"type":"response.output_text.delta","delta":""}"#;
        assert!(transform_codex_line(line).is_none());
    }

    // ── Real codex output integration test ──────────────────────────────
    // These are the exact lines from `codex exec --json "say hello world in one short sentence"`
    // captured on 2026-02-07 with codex-cli 0.98.0

    #[test]
    fn test_real_codex_output_thread_started() {
        let line = r#"{"type":"thread.started","thread_id":"019c363b-c0c9-7362-b5da-5c0de26258d1"}"#;
        assert!(transform_codex_line(line).is_none(), "thread.started should be skipped");
    }

    #[test]
    fn test_real_codex_output_turn_started() {
        let line = r#"{"type":"turn.started"}"#;
        assert!(transform_codex_line(line).is_none(), "turn.started should be skipped");
    }

    #[test]
    fn test_real_codex_output_reasoning() {
        let line = r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Providing simple greeting**"}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(
            parsed["message"]["content"][0]["text"],
            "[thinking] **Providing simple greeting**"
        );
    }

    #[test]
    fn test_real_codex_output_agent_message() {
        let line = r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello world."}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(parsed["message"]["content"][0]["text"], "Hello world.");
    }

    #[test]
    fn test_real_codex_output_turn_completed() {
        let line = r#"{"type":"turn.completed","usage":{"input_tokens":7855,"cached_input_tokens":6528,"output_tokens":37}}"#;
        let result = transform_codex_line(line).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["type"], "result");
        assert_eq!(parsed["usage"]["input_tokens"], 7855);
        assert_eq!(parsed["usage"]["output_tokens"], 37);
    }

    #[test]
    fn test_real_codex_full_sequence() {
        // Simulate the full 5-line sequence and verify exactly 3 messages are emitted
        let lines = [
            r#"{"type":"thread.started","thread_id":"019c363b-c0c9-7362-b5da-5c0de26258d1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Providing simple greeting**"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello world."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":7855,"cached_input_tokens":6528,"output_tokens":37}}"#,
        ];

        let results: Vec<Option<String>> = lines.iter().map(|l| transform_codex_line(l)).collect();

        // thread.started → None, turn.started → None
        assert!(results[0].is_none());
        assert!(results[1].is_none());

        // reasoning → assistant message
        let r2: Value = serde_json::from_str(results[2].as_ref().unwrap()).unwrap();
        assert_eq!(r2["type"], "assistant");
        assert!(r2["message"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("[thinking]"));

        // agent_message → assistant message
        let r3: Value = serde_json::from_str(results[3].as_ref().unwrap()).unwrap();
        assert_eq!(r3["type"], "assistant");
        assert_eq!(r3["message"]["content"][0]["text"], "Hello world.");

        // turn.completed → result
        let r4: Value = serde_json::from_str(results[4].as_ref().unwrap()).unwrap();
        assert_eq!(r4["type"], "result");
    }
}
