use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";
const DEFAULT_TITLE_MODEL: &str = "glm-4.7-flash";
const MAX_TITLE_CHARS: usize = 72;
const SYSTEM_PROMPT: &str = "Generate a concise, functional terminal tab title from a coding conversation transcript. Return exactly one short line with no quotes.";

#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: Option<OllamaMessage>,
}

#[derive(Debug, Deserialize)]
struct OllamaMessage {
    content: Option<String>,
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<&str>>().join(" ")
}

fn sanitize_generated_title(raw: &str) -> String {
    let first_line = raw
        .lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .unwrap_or("");

    let without_edges = first_line.trim_matches(|ch: char| {
        ch == '`' || ch == '"' || ch == '\'' || ch == '*' || ch == '#' || ch == '-' || ch == '>'
    });

    let normalized = collapse_whitespace(without_edges);
    if normalized.is_empty() {
        return String::new();
    }

    normalized.chars().take(MAX_TITLE_CHARS).collect::<String>()
}

fn extract_title_from_ollama_response(raw: &str) -> Result<String, String> {
    let parsed: OllamaChatResponse =
        serde_json::from_str(raw).map_err(|e| format!("Failed to parse Ollama response JSON: {}", e))?;

    let content = parsed
        .message
        .and_then(|message| message.content)
        .unwrap_or_default();
    let sanitized = sanitize_generated_title(&content);

    if sanitized.is_empty() {
        return Err("Generated title was empty".to_string());
    }

    Ok(sanitized)
}

#[tauri::command]
pub async fn generate_local_terminal_title(
    transcript: String,
    model: Option<String>,
) -> Result<String, String> {
    if transcript.trim().is_empty() {
        return Err("Transcript cannot be empty".to_string());
    }

    let ollama_base_url =
        std::env::var("OLLAMA_BASE_URL").unwrap_or_else(|_| DEFAULT_OLLAMA_BASE_URL.to_string());
    let target_model = model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_TITLE_MODEL);

    let payload = json!({
      "model": target_model,
      "messages": [
        {
          "role": "system",
          "content": SYSTEM_PROMPT
        },
        {
          "role": "user",
          "content": format!("Transcript:\n{}\n\nReturn only the title.", transcript)
        }
      ],
      "stream": false,
      "options": {
        "temperature": 0.1
      }
    });

    let endpoint = format!("{}/api/chat", ollama_base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to construct HTTP client: {}", e))?;

    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to call Ollama: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Ollama API error ({}): {}", status, error_text));
    }

    let raw = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Ollama response body: {}", e))?;

    extract_title_from_ollama_response(&raw)
}

#[cfg(test)]
mod tests {
    use super::{extract_title_from_ollama_response, sanitize_generated_title};

    #[test]
    fn sanitize_generated_title_keeps_single_line() {
        let value = sanitize_generated_title("  \"Refactor Parser Pipeline\" \nextra line");
        assert_eq!(value, "Refactor Parser Pipeline");
    }

    #[test]
    fn sanitize_generated_title_limits_length() {
        let long = "a".repeat(120);
        let value = sanitize_generated_title(&long);
        assert_eq!(value.len(), 72);
    }

    #[test]
    fn extract_title_from_ollama_response_parses_content() {
        let raw = r#"{"message":{"content":"\"Native Terminal Session Summary\"\nignored"}}"#;
        let value = extract_title_from_ollama_response(raw).expect("expected valid title");
        assert_eq!(value, "Native Terminal Session Summary");
    }

    #[test]
    fn extract_title_from_ollama_response_rejects_empty_title() {
        let raw = r#"{"message":{"content":"   "}}"#;
        let result = extract_title_from_ollama_response(raw);
        assert!(result.is_err());
    }
}
