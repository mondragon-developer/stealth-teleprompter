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
#[cfg(desktop)]
static KEY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// Sequence number of the newest answer request. An older stream still
// running when a new question is asked stops reading, which also stops the
// provider generating (and billing) tokens nobody will see.
static LATEST: AtomicU64 = AtomicU64::new(0);

#[cfg(all(test, desktop))]
mod credential_tests {
    use super::delete_and_verify;
    use keyring::Error;

    #[test]
    fn deletion_requires_an_absent_credential() {
        assert!(delete_and_verify(|| Ok(()), || Err(Error::NoEntry)).is_ok());
        assert!(delete_and_verify(|| Err(Error::NoEntry), || Err(Error::NoEntry)).is_ok());
        assert!(delete_and_verify(|| Ok(()), || Ok("dummy-test-key".into())).is_err());
    }

    #[test]
    fn keychain_errors_never_report_verified_deletion() {
        let failure = || Error::PlatformFailure(Box::new(std::io::Error::other("test failure")));
        assert!(delete_and_verify(|| Err(failure()), || panic!("must not read after failed delete")).is_err());
        assert!(delete_and_verify(|| Ok(()), || Err(failure())).is_err());
    }
}

#[cfg(test)]
mod endpoint_tests {
    use super::*;

    fn provider(id: &str, url: &str) -> Provider {
        Provider { id: id.into(), kind: if id == "claude" { "anthropic" } else { "openai" }.into(),
            base_url: url.into(), model: "test-model".into() }
    }

    #[test]
    fn preset_keys_cannot_be_redirected_to_another_origin_or_api_format() {
        for (id, url) in [("claude", "https://api.anthropic.com"), ("openai", "https://api.openai.com/v1"),
            ("kimi", "https://api.moonshot.ai/v1")] {
            assert!(validate_provider(&provider(id, url)).is_ok());
            for bad in ["http://localhost:8000", "https://example.com", "https://api.anthropic.com.example.com",
                "https://api.anthropic.com:444", "https://api.anthropic.com/other"] {
                assert!(validate_provider(&provider(id, bad)).is_err());
            }
        }
        let mut p = provider("claude", "https://api.anthropic.com");
        p.kind = "openai".into();
        assert!(validate_provider(&p).is_err());
        assert!(validate_provider_id("unknown").is_err());
    }

    #[test]
    fn custom_servers_require_https_except_loopback_and_reject_url_credentials() {
        for good in ["http://localhost:1234/v1", "http://127.0.0.1:11434/v1", "http://[::1]:1234/v1", "https://models.example.com/v1"] {
            assert!(validate_provider(&provider("custom", good)).is_ok(), "{good}");
        }
        for bad in ["http://192.168.1.2/v1", "http://localhost.example.com/v1", "file:///tmp/model",
            "https://user:password@example.com/v1", "https://example.com/v1?key=example", "https://example.com/v1#key"] {
            assert!(validate_provider(&provider("custom", bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn credential_client_does_not_follow_redirects() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let url = format!("http://{}/", source.local_addr().unwrap());
        let location = format!("http://{}/", target.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = source.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut buffer = [0; 4096];
            socket.read(&mut buffer).unwrap();
            write!(socket, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let status = tauri::async_runtime::block_on(async {
            client_builder().no_proxy().build().unwrap().get(url)
                .header("x-api-key", "dummy-test-key").send().await.unwrap().status()
        });
        server.join().unwrap();
        assert_eq!(status, reqwest::StatusCode::FOUND);
        assert_eq!(target.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }
}

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
    Usage { input_tokens: u64, output_tokens: u64 },
    Done,
}

#[cfg(desktop)]
fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    validate_provider_id(id)?;
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn read_key(id: &str) -> Result<Option<String>, String> {
    match key_entry(id)?.get_password() {
        Ok(key) => Ok(Some(key).filter(|key| !key.is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the system keychain. Unlock it and try again.".into()),
    }
}

#[cfg(not(desktop))]
fn read_key(_id: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(desktop)]
#[tauri::command]
pub fn llm_set_key(id: String, key: String) -> Result<(), String> {
    let _guard = KEY_LOCK.lock().map_err(|_| "key storage lock failed")?;
    let entry = key_entry(&id)?;
    let key = key.trim();
    if key.is_empty() {
        delete_and_verify(|| entry.delete_credential(), || entry.get_password())
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

#[cfg(desktop)]
fn delete_and_verify(
    delete: impl FnOnce() -> Result<(), keyring::Error>,
    read: impl FnOnce() -> Result<String, keyring::Error>,
) -> Result<(), String> {
    match delete() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("Could not delete saved key: {e}")),
    }
    match read() {
        Err(keyring::Error::NoEntry) => Ok(()),
        Ok(_) => Err("Deletion could not be verified: a saved key still exists. Try again.".into()),
        Err(e) => Err(format!("Could not verify deletion: {e}. Try again.")),
    }
}

#[tauri::command]
pub fn llm_delete_key(id: String) -> Result<(), String> {
    llm_set_key(id, String::new())
}

#[cfg(desktop)]
#[tauri::command]
pub fn llm_has_key(id: String) -> Result<bool, String> {
    let _guard = KEY_LOCK.lock().map_err(|_| "key storage lock failed")?;
    match key_entry(&id)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("Could not check saved key: {e}")),
    }
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn llm_has_key(_id: String) -> Result<bool, String> {
    Err("key storage is desktop only".into())
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        // Never forward credentials (especially x-api-key) to redirect targets.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(60))
}

fn client() -> Result<reqwest::Client, String> {
    client_builder().build().map_err(|e| e.to_string())
}

fn base(p: &Provider) -> String {
    p.base_url.trim().trim_end_matches('/').to_string()
}

fn validate_provider_id(id: &str) -> Result<(), String> {
    if matches!(id, "claude" | "openai" | "kimi" | "lmstudio" | "custom") {
        Ok(())
    } else {
        Err("Unknown provider".into())
    }
}

// Bind preset credentials to their provider, even when the caller edits the URL
// or supplies a mismatched wire format. Only local servers may use plain HTTP.
fn validate_provider(p: &Provider) -> Result<(), String> {
    validate_provider_id(&p.id)?;
    let expected_kind = if p.id == "claude" { "anthropic" } else { "openai" };
    if p.kind != expected_kind {
        return Err("Provider API format does not match the selected provider".into());
    }
    let url = reqwest::Url::parse(&base(p)).map_err(|_| "Invalid provider URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("Provider URL must not contain credentials, query parameters, or fragments".into());
    }
    let host = url.host_str().ok_or("Provider URL needs a host")?;
    let loopback = host == "localhost" || host.trim_matches(['[', ']'])
        .parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("Provider URL must use HTTPS (HTTP is allowed only for localhost)".into());
    }
    let preset = match p.id.as_str() {
        "claude" => Some(("api.anthropic.com", "")),
        "openai" => Some(("api.openai.com", "/v1")),
        "kimi" => Some(("api.moonshot.ai", "/v1")),
        _ => None,
    };
    if let Some((expected_host, expected_path)) = preset {
        if url.scheme() != "https" || host != expected_host
            || url.port_or_known_default() != Some(443)
            || url.path().trim_end_matches('/') != expected_path {
            return Err("This provider's key can only be sent to its official API URL. Use Other OpenAI-compatible with a separate key for custom servers.".into());
        }
    }
    Ok(())
}

fn anthropic_request(p: &Provider, url: &str, post: bool) -> Result<reqwest::RequestBuilder, String> {
    validate_provider(p)?;
    let key = read_key(&p.id)?.ok_or("no API key saved for this provider")?;
    let mut header = reqwest::header::HeaderValue::from_str(&key)
        .map_err(|_| "Invalid API key format")?;
    header.set_sensitive(true);
    let c = client()?;
    let rb = if post { c.post(url) } else { c.get(url) };
    Ok(rb
        .header("x-api-key", header)
        .header("anthropic-version", "2023-06-01"))
}

fn openai_request(p: &Provider, url: &str, post: bool) -> Result<reqwest::RequestBuilder, String> {
    validate_provider(p)?;
    let c = client()?;
    let mut rb = if post { c.post(url) } else { c.get(url) };
    // LM Studio and Ollama run without a key, so a missing one is fine here.
    if let Some(key) = read_key(&p.id)? {
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
        // low effort. Older Haiku models reject the effort parameter.
        if !p.model.contains("haiku") || p.model == "claude-haiku-5-5" {
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
    let mut input_tokens = 0;
    let mut output_tokens = 0;
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
            if anthropic {
                if let Some(usage) = v.pointer("/message/usage").or_else(|| v.get("usage")) {
                    if let Some(n) = usage.get("input_tokens").and_then(Value::as_u64) {
                        input_tokens = n;
                    }
                    if let Some(n) = usage.get("output_tokens").and_then(Value::as_u64) {
                        output_tokens = n;
                    }
                    let _ = on_event.send(AnswerEvent::Usage { input_tokens, output_tokens });
                }
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
