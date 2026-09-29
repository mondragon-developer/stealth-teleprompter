// Answer suggestions from a local or hosted LLM. Two wire formats cover
// every provider in the panel: Anthropic's Messages API for Claude, and the
// OpenAI chat-completions shape that LM Studio, OpenAI, Kimi (Moonshot) and
// Ollama all speak. Requests run here rather than in the webview so API keys
// never leave the Rust side.

use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

const KEYRING_SERVICE: &str = "screen-script";

// Sequence number of the newest answer request. An older stream still
// running when a new question is asked stops reading, which also stops the
// provider generating (and billing) tokens nobody will see.
static LATEST: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
pub struct Provider {
    // Keychain account name; one saved key per provider preset.
    id: String,
    kind: String,
    base_url: String,
    model: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AnswerEvent {
    Delta { text: String },
    Done,
}

#[cfg(desktop)]
fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn read_key(id: &str) -> Option<String> {
    key_entry(id).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

#[cfg(not(desktop))]
fn read_key(_id: &str) -> Option<String> {
    None
}

#[cfg(desktop)]
#[tauri::command]
pub fn llm_set_key(id: String, key: String) -> Result<(), String> {
    let entry = key_entry(&id)?;
    let key = key.trim();
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(key).map_err(|e| e.to_string())
    }
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn llm_set_key(id: String, key: String) -> Result<(), String> {
    let _ = (id, key);
    Err("key storage is desktop only".into())
}

#[tauri::command]
pub fn llm_has_key(id: String) -> bool {
    read_key(&id).is_some()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn base(p: &Provider) -> String {
    p.base_url.trim().trim_end_matches('/').to_string()
}

fn anthropic_request(p: &Provider, url: &str, post: bool) -> Result<reqwest::RequestBuilder, String> {
    let key = read_key(&p.id).ok_or("no API key saved for this provider")?;
    let c = client()?;
    let rb = if post { c.post(url) } else { c.get(url) };
    Ok(rb
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01"))
}

fn openai_request(p: &Provider, url: &str, post: bool) -> Result<reqwest::RequestBuilder, String> {
    let c = client()?;
    let mut rb = if post { c.post(url) } else { c.get(url) };
    // LM Studio and Ollama run without a key, so a missing one is fine here.
    if let Some(key) = read_key(&p.id) {
        rb = rb.bearer_auth(key);
    }
    Ok(rb)
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or(body);
    Err(format!("HTTP {status}: {}", detail.chars().take(300).collect::<String>()))
}

fn connect_error(e: reqwest::Error, p: &Provider) -> String {
    if e.is_connect() && p.kind == "openai" && p.base_url.contains("localhost") {
        "could not reach the local server - is LM Studio running with its server started?".into()
    } else {
        e.to_string()
    }
}

#[tauri::command]
pub async fn llm_models(provider: Provider) -> Result<Vec<String>, String> {
    let p = provider;
    let req = if p.kind == "anthropic" {
        anthropic_request(&p, &format!("{}/v1/models?limit=100", base(&p)), false)?
    } else {
        openai_request(&p, &format!("{}/models", base(&p)), false)?
    };
    let resp = req.send().await.map_err(|e| connect_error(e, &p))?;
    let v: Value = check(resp)
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

#[derive(Serialize)]
pub struct LoadedModel {
    id: String,
    state: String,
    context: u64,
}

// LM Studio answers a request for a model that is not loaded by loading
// another copy (JIT), which can stack several models on the GPU. Its native
// API reports what is actually loaded, so the panel can say so up front.
// Servers without that endpoint (Ollama, OpenAI) just get an error here.
#[tauri::command]
pub async fn llm_loaded(provider: Provider) -> Result<Vec<LoadedModel>, String> {
    let p = provider;
    if p.kind != "openai" {
        return Err("not an LM Studio server".into());
    }
    let b = base(&p);
    let origin = b.strip_suffix("/v1").unwrap_or(&b);
    let resp = openai_request(&p, &format!("{origin}/api/v0/models"), false)?
        .send()
        .await
        .map_err(|e| connect_error(e, &p))?;
    let v: Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("type").and_then(|t| t.as_str()) != Some("embeddings"))
                .filter_map(|m| {
                    let state = m.get("state")?.as_str()?;
                    if state == "not-loaded" {
                        return None;
                    }
                    Some(LoadedModel {
                        id: m.get("id")?.as_str()?.to_string(),
                        state: state.to_string(),
                        context: m
                            .get("loaded_context_length")
                            .and_then(|c| c.as_u64())
                            .unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn llm_answer(
    provider: Provider,
    system: String,
    prompt: String,
    seq: u64,
    on_event: Channel<AnswerEvent>,
) -> Result<(), String> {
    LATEST.fetch_max(seq, Ordering::SeqCst);
    let p = provider;
    if p.model.trim().is_empty() {
        return Err("pick a model first".into());
    }
    let anthropic = p.kind == "anthropic";
    let req = if anthropic {
        let mut body = json!({
            "model": p.model,
            "max_tokens": 2048,
            "stream": true,
            "system": system,
            "messages": [{ "role": "user", "content": prompt }],
        });
        // Answers are needed within seconds while someone waits, so ask for
        // low effort. Haiku rejects the effort parameter.
        if !p.model.contains("haiku") {
            body["output_config"] = json!({ "effort": "low" });
        }
        let mut rb = anthropic_request(&p, &format!("{}/v1/messages", base(&p)), true)?;
        // Opus 5 and Fable 5.1 can decline on a safety classifier; the
        // server-side fallback retries on another model instead of leaving
        // the panel empty mid-meeting.
        if p.model == "claude-opus-5" || p.model == "claude-fable-5-1" {
            body["fallbacks"] = json!("default");
            rb = rb.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        rb.json(&body)
    } else {
        let body = json!({
            "model": p.model,
            "stream": true,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": prompt },
            ],
        });
        openai_request(&p, &format!("{}/chat/completions", base(&p)), true)?.json(&body)
    };

    let resp = req.send().await.map_err(|e| connect_error(e, &p))?;
    let resp = check(resp).await?;
    let mut stream = resp.bytes_stream();
    let mut raw: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        if LATEST.load(Ordering::SeqCst) != seq {
            return Ok(());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        // Chunks can split a multi-byte character, so decode only up to the
        // last complete line.
        raw.extend_from_slice(&chunk);
        let Some(nl) = raw.iter().rposition(|b| *b == b'\n') else { continue };
        let complete: Vec<u8> = raw.drain(..=nl).collect();
        for line in String::from_utf8_lossy(&complete).lines() {
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(msg) = v.pointer("/error/message").and_then(|m| m.as_str()) {
                return Err(msg.to_string());
            }
            let text = if anthropic {
                if v.get("type").and_then(|t| t.as_str()) == Some("content_block_delta")
                    && v.pointer("/delta/type").and_then(|t| t.as_str()) == Some("text_delta")
                {
                    v.pointer("/delta/text").and_then(|t| t.as_str())
                } else {
                    None
                }
            } else {
                v.pointer("/choices/0/delta/content").and_then(|t| t.as_str())
            };
            if let Some(t) = text {
                if !t.is_empty() {
                    let _ = on_event.send(AnswerEvent::Delta { text: t.to_string() });
                }
            }
        }
    }
    let _ = on_event.send(AnswerEvent::Done);
    Ok(())
}
