// Local speech recognition for voice-follow (microphone) and the answer
// panel (system audio loopback). Windows only for now: cpal has no loopback
// capture on macOS, and whisper.cpp inside the universal macOS build is an
// untested cross-compile. Other platforms get stubs that report the gap.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct AsrText {
    pub source: &'static str,
    pub text: String,
}

#[derive(Serialize)]
pub struct ModelStatus {
    pub present: bool,
    pub bytes: u64,
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::VecDeque;
    use std::fs;
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, Sample, SampleFormat, SizedSample};
    use futures_util::StreamExt;
    use tauri::ipc::Channel;
    use tauri::{AppHandle, Emitter, Manager, State};
    use whisper_rs::{
        FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
    };

    const MODELS: &[&str] = &["tiny", "base", "small"];
    const TARGET_RATE: usize = 16_000;
    // Below this RMS a window is treated as silence and never reaches
    // whisper, which otherwise hallucinates filler like "Thank you." on
    // quiet input.
    const SILENCE_RMS: f32 = 0.008;
    const TRANSCRIPT_KEEP: Duration = Duration::from_secs(180);

    struct Capture {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    // Dropping a capture stops its thread and waits for it, so replacing
    // or clearing the slot can never leave a stray mic stream running.
    impl Drop for Capture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    #[derive(Default)]
    pub struct Speech {
        model: Mutex<Option<(String, Arc<WhisperContext>)>>,
        mic: Mutex<Option<Capture>>,
        sys: Mutex<Option<Capture>>,
        prompt: Arc<Mutex<String>>,
        transcript: Arc<Mutex<VecDeque<(Instant, String)>>>,
    }

    fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("models");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    fn model_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
        if !MODELS.contains(&name) {
            return Err("unknown speech model".into());
        }
        Ok(models_dir(app)?.join(format!("ggml-{name}.bin")))
    }

    fn load_model(app: &AppHandle, speech: &Speech, name: &str) -> Result<Arc<WhisperContext>, String> {
        let mut slot = speech.model.lock().unwrap();
        if let Some((loaded, ctx)) = slot.as_ref() {
            if loaded == name {
                return Ok(ctx.clone());
            }
        }
        let path = model_path(app, name)?;
        if !path.exists() {
            return Err("speech model not downloaded".into());
        }
        whisper_rs::install_logging_hooks();
        let ctx = WhisperContext::new_with_params(
            &path,
            WhisperContextParameters::default(),
        )
        .map_err(|e| format!("could not load speech model: {e}"))?;
        let ctx = Arc::new(ctx);
        *slot = Some((name.to_string(), ctx.clone()));
        Ok(ctx)
    }

    #[tauri::command]
    pub fn speech_supported() -> bool {
        true
    }

    #[tauri::command]
    pub fn model_status(app: AppHandle, name: String) -> Result<ModelStatus, String> {
        let path = model_path(&app, &name)?;
        let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Ok(ModelStatus {
            present: bytes > 0,
            bytes,
        })
    }

    #[tauri::command]
    pub async fn download_model(
        app: AppHandle,
        name: String,
        progress: Channel<u32>,
    ) -> Result<(), String> {
        let path = model_path(&app, &name)?;
        let part = path.with_extension("part");
        let url = format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin"
        );
        let resp = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("download failed: HTTP {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut got: u64 = 0;
        let mut last_pct = u32::MAX;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                let _ = fs::remove_file(&part);
                e.to_string()
            })?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            if total > 0 {
                let pct = (got * 100 / total) as u32;
                if pct != last_pct {
                    last_pct = pct;
                    let _ = progress.send(pct);
                }
            }
        }
        drop(file);
        // No published checksums to pin against, so at least reject a
        // truncated file or an HTML error page saved under the model name.
        let mut magic = [0u8; 4];
        let ok = (total == 0 || got == total)
            && got > 30_000_000
            && fs::File::open(&part)
                .and_then(|mut f| f.read_exact(&mut magic))
                .is_ok()
            && u32::from_le_bytes(magic) == 0x6767_6d6c;
        if !ok {
            let _ = fs::remove_file(&part);
            return Err("downloaded file is not a valid speech model".into());
        }
        fs::rename(&part, &path).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn voice_context(speech: State<Speech>, text: String) {
        *speech.prompt.lock().unwrap() = text;
    }

    // async: loading a model and joining a busy capture thread take seconds,
    // which would freeze the window on the main thread. The slot lock is held
    // across stop and start so two quick toggles cannot both spawn.
    #[tauri::command(async)]
    pub fn voice_start(
        app: AppHandle,
        speech: State<Speech>,
        model: String,
        language: String,
    ) -> Result<(), String> {
        let mut slot = speech.mic.lock().unwrap();
        *slot = None;
        let ctx = load_model(&app, &speech, &model)?;
        let prompt = speech.prompt.clone();
        let a = app.clone();
        *slot = Some(spawn_capture(app, "mic", ctx, move |state, stop, buf, rate| {
            mic_loop(a, state, stop, buf, rate, language, prompt)
        })?);
        Ok(())
    }

    #[tauri::command(async)]
    pub fn voice_stop(speech: State<Speech>) {
        *speech.mic.lock().unwrap() = None;
    }

    #[tauri::command(async)]
    pub fn listen_start(
        app: AppHandle,
        speech: State<Speech>,
        model: String,
        language: String,
    ) -> Result<(), String> {
        let mut slot = speech.sys.lock().unwrap();
        *slot = None;
        let ctx = load_model(&app, &speech, &model)?;
        let transcript = speech.transcript.clone();
        let a = app.clone();
        *slot = Some(spawn_capture(app, "sys", ctx, move |state, stop, buf, rate| {
            loopback_loop(a, state, stop, buf, rate, language, transcript)
        })?);
        Ok(())
    }

    #[tauri::command(async)]
    pub fn listen_stop(speech: State<Speech>) {
        *speech.sys.lock().unwrap() = None;
    }

    #[tauri::command]
    pub fn transcript_recent(speech: State<Speech>, seconds: u64) -> String {
        let cutoff = Instant::now()
            .checked_sub(Duration::from_secs(seconds))
            .unwrap_or_else(Instant::now);
        speech
            .transcript
            .lock()
            .unwrap()
            .iter()
            .filter(|(t, _)| *t >= cutoff)
            .map(|(_, s)| s.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[tauri::command]
    pub fn transcript_clear(speech: State<Speech>) {
        speech.transcript.lock().unwrap().clear();
    }

    type Buffer = Arc<Mutex<Vec<f32>>>;

    // The cpal stream is not Send, so it lives and dies on the capture
    // thread; the recognition loop runs there too while the audio callback
    // keeps filling the buffer on cpal's own thread.
    fn spawn_capture<F>(
        app: AppHandle,
        source: &'static str,
        ctx: Arc<WhisperContext>,
        run: F,
    ) -> Result<Capture, String>
    where
        F: FnOnce(WhisperState, Arc<AtomicBool>, Buffer, usize) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let stop_t = stop.clone();
        let thread = std::thread::spawn(move || {
            let state = match ctx.create_state() {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("speech engine failed to start: {e}")));
                    return;
                }
            };
            let buf: Buffer = Arc::new(Mutex::new(Vec::new()));
            let (stream, rate) = match open_stream(&app, source, buf.clone()) {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));
            run(state, stop_t, buf, rate);
            drop(stream);
        });
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Capture {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err("audio thread exited".into()),
        }
    }

    fn open_stream(
        app: &AppHandle,
        source: &'static str,
        buf: Buffer,
    ) -> Result<(cpal::Stream, usize), String> {
        let loopback = source == "sys";
        let host = cpal::default_host();
        // WASAPI records what an output device plays when an input stream
        // is built on it; that is how other meeting participants are heard.
        let device = if loopback {
            host.default_output_device()
        } else {
            host.default_input_device()
        }
        .ok_or(if loopback {
            "no audio output device"
        } else {
            "no microphone found"
        })?;
        let config = if loopback {
            device.default_output_config()
        } else {
            device.default_input_config()
        }
        .map_err(|e| e.to_string())?;
        let rate = config.sample_rate() as usize;
        let channels = config.channels() as usize;
        let (a, cfg) = (app.clone(), config.clone().into());
        let stream = match config.sample_format() {
            SampleFormat::F32 => build::<f32>(&device, cfg, channels, buf, a, source),
            SampleFormat::I16 => build::<i16>(&device, cfg, channels, buf, a, source),
            SampleFormat::I32 => build::<i32>(&device, cfg, channels, buf, a, source),
            SampleFormat::U16 => build::<u16>(&device, cfg, channels, buf, a, source),
            other => return Err(format!("unsupported audio format {other}")),
        }?;
        stream.play().map_err(|e| e.to_string())?;
        Ok((stream, rate))
    }

    fn build<T>(
        device: &cpal::Device,
        config: cpal::StreamConfig,
        channels: usize,
        buf: Buffer,
        app: AppHandle,
        source: &'static str,
    ) -> Result<cpal::Stream, String>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        device
            .build_input_stream(
                config,
                move |data: &[T], _: &cpal::InputCallbackInfo| {
                    let mut b = buf.lock().unwrap();
                    for frame in data.chunks(channels.max(1)) {
                        let sum: f32 = frame.iter().map(|s| f32::from_sample(*s)).sum();
                        b.push(sum / frame.len() as f32);
                    }
                },
                move |e| {
                    // WASAPI reports a dropped buffer (Xrun) or a reroute to a new
                    // default device while the stream keeps running; stopping for
                    // those would kill voice follow over a millisecond glitch.
                    if matches!(e.kind(), cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged) {
                        return;
                    }
                    let _ = app.emit(
                        "asr-error",
                        AsrText {
                            source,
                            text: e.to_string(),
                        },
                    );
                },
                None,
            )
            .map_err(|e| e.to_string())
    }

    fn resample(input: &[f32], rate: usize) -> Vec<f32> {
        if rate == TARGET_RATE || input.is_empty() {
            return input.to_vec();
        }
        let ratio = rate as f64 / TARGET_RATE as f64;
        let n = (input.len() as f64 / ratio) as usize;
        (0..n)
            .map(|i| {
                let pos = i as f64 * ratio;
                let j = pos as usize;
                let frac = (pos - j as f64) as f32;
                let a = input[j];
                let b = *input.get(j + 1).unwrap_or(&a);
                a + (b - a) * frac
            })
            .collect()
    }

    fn rms(s: &[f32]) -> f32 {
        if s.is_empty() {
            return 0.0;
        }
        (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt()
    }

    // Small models can loop on a phrase ("I have available. My intention is
    // to help. My intention is to help."). The tail of a loop matches words
    // already read, so voice follow would jump back; keep the first pass.
    fn trim_repeats(text: &str) -> String {
        let words: Vec<&str> = text.split_whitespace().collect();
        let key = |w: &str| {
            w.chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>()
        };
        let norm: Vec<String> = words.iter().map(|w| key(w)).collect();
        for start in 0..norm.len() {
            for len in 3..=(norm.len() - start) / 2 {
                if norm[start..start + len] == norm[start + len..start + 2 * len] {
                    return words[..start + len].join(" ");
                }
            }
        }
        words.join(" ")
    }

    fn transcribe(
        state: &mut WhisperState,
        audio: &[f32],
        language: &str,
        prompt: &str,
    ) -> Option<String> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4))
            .unwrap_or(2);
        params.set_n_threads(threads as i32);
        params.set_language(if language == "auto" { None } else { Some(language) });
        params.set_no_context(true);
        params.set_single_segment(true);
        params.set_no_timestamps(true);
        params.set_suppress_blank(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        // Whisper encodes a fixed 30 s window (1500 frames of 20 ms) however
        // short the clip. Sizing the context to the clip made base ~6x
        // faster on a 4 s window; below ~384 frames it starts looping.
        let frames = audio.len() / 320;
        params.set_audio_ctx((frames + 64).clamp(384, 1500) as i32);
        // Fallback decoding retries at higher temperature and cost up to 2 s
        // on a looping window; a looped or clipped result is cheaper to drop.
        params.set_temperature_inc(0.0);
        params.set_max_tokens((frames / 50 * 8 + 16) as i32);
        if !prompt.is_empty() {
            params.set_initial_prompt(prompt);
        }
        state.full(params, audio).ok()?;
        let text: String = state
            .as_iter()
            .filter_map(|s| s.to_str_lossy().ok().map(|c| c.into_owned()))
            .collect::<Vec<_>>()
            .join(" ");
        let text = trim_repeats(text.trim());
        // Whisper marks non-speech with bracketed tags like [BLANK_AUDIO].
        if text.is_empty() || (text.starts_with('[') && text.ends_with(']')) {
            None
        } else {
            Some(text)
        }
    }

    // Voice-follow re-reads a sliding window of the last few seconds so the
    // newest words are always at the end of the text; the frontend aligns
    // that tail against the script.
    fn mic_loop(
        app: AppHandle,
        mut state: WhisperState,
        stop: Arc<AtomicBool>,
        buf: Buffer,
        rate: usize,
        language: String,
        prompt: Arc<Mutex<String>>,
    ) {
        let window = rate * 4;
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(250));
            let raw = {
                let mut b = buf.lock().unwrap();
                if b.len() > window {
                    let cut = b.len() - window;
                    b.drain(..cut);
                }
                b.clone()
            };
            if raw.len() < rate {
                continue;
            }
            let tail = &raw[raw.len().saturating_sub(rate / 2)..];
            if rms(tail) < SILENCE_RMS {
                continue;
            }
            let audio = resample(&raw, rate);
            let p = prompt.lock().unwrap().clone();
            if let Some(text) = transcribe(&mut state, &audio, &language, &p) {
                let _ = app.emit("asr", AsrText { source: "mic", text });
            }
        }
    }

    // Loopback audio is cut into utterances at pauses so each transcript
    // entry is a whole phrase, which keeps questions intact for the LLM.
    fn loopback_loop(
        app: AppHandle,
        mut state: WhisperState,
        stop: Arc<AtomicBool>,
        buf: Buffer,
        rate: usize,
        language: String,
        transcript: Arc<Mutex<VecDeque<(Instant, String)>>>,
    ) {
        let mut chunk: Vec<f32> = Vec::new();
        let mut voiced = false;
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(300));
            let fresh: Vec<f32> = std::mem::take(&mut *buf.lock().unwrap());
            let loud = rms(&fresh) >= SILENCE_RMS;
            if loud {
                voiced = true;
            }
            if voiced {
                chunk.extend_from_slice(&fresh);
            }
            let secs = chunk.len() as f32 / rate as f32;
            let pause = !loud && secs >= 1.5;
            if !(voiced && (pause || secs >= 12.0)) {
                continue;
            }
            let audio = resample(&chunk, rate);
            chunk.clear();
            voiced = false;
            if let Some(text) = transcribe(&mut state, &audio, &language, "") {
                {
                    let mut t = transcript.lock().unwrap();
                    t.push_back((Instant::now(), text.clone()));
                    while t
                        .front()
                        .is_some_and(|(at, _)| at.elapsed() > TRANSCRIPT_KEEP)
                    {
                        t.pop_front();
                    }
                }
                let _ = app.emit("asr", AsrText { source: "sys", text });
            }
        }
    }
}

#[cfg(not(windows))]
pub use stub::*;

#[cfg(not(windows))]
mod stub {
    use super::*;

    const UNSUPPORTED: &str = "speech recognition is Windows-only for now";

    #[derive(Default)]
    pub struct Speech;

    #[tauri::command]
    pub fn speech_supported() -> bool {
        false
    }

    #[tauri::command]
    pub fn model_status(name: String) -> Result<ModelStatus, String> {
        let _ = name;
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn download_model(
        name: String,
        progress: tauri::ipc::Channel<u32>,
    ) -> Result<(), String> {
        let _ = (name, progress);
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn voice_context(text: String) {
        let _ = text;
    }

    #[tauri::command]
    pub fn voice_start(model: String, language: String) -> Result<(), String> {
        let _ = (model, language);
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn voice_stop() {}

    #[tauri::command]
    pub fn listen_start(model: String, language: String) -> Result<(), String> {
        let _ = (model, language);
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn listen_stop() {}

    #[tauri::command]
    pub fn transcript_recent(seconds: u64) -> String {
        let _ = seconds;
        String::new()
    }

    #[tauri::command]
    pub fn transcript_clear() {}

}
