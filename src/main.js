const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { Channel } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const scriptText = $("script-text");

const DEFAULTS = {
  fontSize: 30,
  opacity: 85,
  speed: 60,
  lastScript: null,
  positions: {},
  countdown: true,
  hotkeys: {},
  theme: "dark",
  wordHighlight: true,
  asrModel: "base",
  asrLang: "auto",
  ai: { provider: "lmstudio", includeScript: true, notes: "", providers: {} },
};

const SPEED_MAX = 300;

// Presets for the answer panel. Each keeps its own URL, model and saved key,
// so switching providers mid-meeting does not wipe the others.
const PROVIDERS = {
  lmstudio: { kind: "openai", url: "http://localhost:1234/v1", model: "" },
  claude: { kind: "anthropic", url: "https://api.anthropic.com", model: "claude-opus-5" },
  openai: { kind: "openai", url: "https://api.openai.com/v1", model: "" },
  kimi: { kind: "openai", url: "https://api.moonshot.ai/v1", model: "" },
  custom: { kind: "openai", url: "http://localhost:11434/v1", model: "" },
};

const ANSWER_SYSTEM = "You help a presenter answer questions live, during a talk or meeting. You get the presenter's script and notes as background, plus a transcript of what other people said (automatic transcription, so expect errors). Find the question the presenter needs to answer: the typed question if there is one, otherwise the most recent question in the transcript. Reply with 2 or 3 alternative answers the presenter could say out loud, each one or two short sentences, as a list with every item starting with \"- \". Use the language of the question. Base the answers on the script and notes; when they do not cover the question, say so in one short item and give a safe general answer. No preamble and no headings.";

const DEFAULT_HOTKEYS = {
  "toggle-play": "ctrl+alt+Space",
  "speed-up": "ctrl+alt+ArrowUp",
  "speed-down": "ctrl+alt+ArrowDown",
  "jump-back": "ctrl+alt+ArrowLeft",
  "jump-forward": "ctrl+alt+ArrowRight",
  "restart": "ctrl+alt+Home",
  "toggle-visibility": "ctrl+alt+KeyH",
  "toggle-click-through": "ctrl+alt+KeyG",
  "toggle-voice": "ctrl+alt+KeyV",
  "answer": "ctrl+alt+KeyQ",
};

const HOTKEY_ACTIONS = [
  ["toggle-play", "play / pause"],
  ["speed-up", "faster"],
  ["speed-down", "slower"],
  ["jump-back", "jump back"],
  ["jump-forward", "jump forward"],
  ["restart", "back to top"],
  ["toggle-visibility", "hide / show window"],
  ["toggle-click-through", "click-through on / off"],
  ["toggle-voice", "voice follow on / off"],
  ["answer", "suggest answers"],
];

let settings = { ...DEFAULTS };
let scripts = [];
let current = null;
let playing = false;
let ghost = false;
let stealth = true;
let carry = 0;
let lastTick = performance.now();
let saveTimer = null;
let scrollPending = false;
let hotkeys = { bindings: { ...DEFAULT_HOTKEYS }, unavailable: [] };
let recording = null;
let countdownTimer = null;
let editing = false;
let currentRaw = "";
let words = [];
let normWords = [];
let lines = [];
let layoutDirty = true;
let wordIdx = -1;
let shownIdx = -1;
let speechOk = false;
let voiceOn = false;
let voiceStarting = false;
let listenOn = false;
let listenStarting = false;
let manualUntil = 0;
let contextTimer = null;
let answerSeq = 0;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_settings", { settings }).catch(() => {});
  }, 400);
}

function applyUI() {
  const root = document.documentElement.style;
  root.setProperty("--font-size", settings.fontSize + "px");
  root.setProperty("--panel-alpha", settings.opacity / 100);
  $("speed").value = speedToSlider(settings.speed);
  $("speed-val").textContent = settings.speed;
  $("btn-words").classList.toggle("active", !!settings.wordHighlight);
  $("opacity").value = settings.opacity;
  $("btn-count").classList.toggle("active", !!settings.countdown);
  document.body.classList.toggle("light", settings.theme === "light");
  $("btn-theme").textContent = settings.theme === "light" ? "Dark" : "Light";
}

function mdLite(text) {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      if (/^#{1,6}\s/.test(t)) {
        return `<h2>${t.replace(/^#{1,6}\s+/, "")}</h2>`;
      }
      const html = t
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\r?\n/g, "<br>");
      return `<p>${html}</p>`;
    })
    .join("");
}

function normalizeWord(w) {
  return w
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Words are wrapped after mdLite so its strong/em/br markup stays intact.
function wrapWords() {
  words = [];
  const walker = document.createTreeWalker(scriptText, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of node.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else {
        const span = document.createElement("span");
        span.className = "w";
        span.textContent = part;
        frag.appendChild(span);
        words.push(span);
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
  normWords = words.map((w) => normalizeWord(w.textContent));
}

function renderScript(text) {
  scriptText.innerHTML = mdLite(text);
  wrapWords();
  layoutDirty = true;
  wordIdx = -1;
  shownIdx = -1;
}

// Word positions are measured once per layout and binary-searched on every
// scroll frame; reading thousands of rects per frame would thrash layout.
function buildLayout() {
  layoutDirty = false;
  lines = [];
  const vpTop = viewport.getBoundingClientRect().top;
  const st = viewport.scrollTop;
  let line = null;
  for (let i = 0; i < words.length; i++) {
    const r = words[i].getBoundingClientRect();
    const top = r.top - vpTop + st;
    if (!line || Math.abs(top - line.top) > r.height * 0.5) {
      line = { top, bottom: top + r.height, first: i, last: i };
      lines.push(line);
    } else {
      line.last = i;
      line.bottom = Math.max(line.bottom, top + r.height);
    }
  }
}

function focusOffset() {
  return viewport.clientHeight * 0.33;
}

function lineOfWord(i) {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].first <= i) lo = mid;
    else hi = mid - 1;
  }
  return lines[lo];
}

// The word under the focus line: the line crossing it, then a position
// along that line proportional to how far the line has scrolled past, so
// the highlight sweeps each line at the scroll pace.
function wordFromFocus() {
  if (!lines.length) return -1;
  const y = viewport.scrollTop + focusOffset();
  if (y < lines[0].top) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  const l = lines[lo];
  const frac = clamp((y - l.top) / (l.bottom - l.top), 0, 0.999);
  return l.first + Math.floor(frac * (l.last - l.first + 1));
}

function showWord(i) {
  const target = settings.wordHighlight ? i : -1;
  if (target === shownIdx) return;
  if (shownIdx >= 0 && words[shownIdx]) words[shownIdx].classList.remove("now");
  if (target >= 0 && words[target]) words[target].classList.add("now");
  shownIdx = target;
}

function markManual() {
  if (voiceOn) manualUntil = performance.now() + 2000;
}

function maxScroll() {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}

function savePosition() {
  if (!current) return;
  const max = maxScroll();
  if (!settings.positions) settings.positions = {};
  settings.positions[current.path] = max > 0 ? viewport.scrollTop / max : 0;
  saveSettingsSoon();
}

function renderTimeLeft() {
  const el = $("time-left");
  if (!current) {
    el.textContent = "";
    return;
  }
  if (settings.speed <= 0) {
    el.textContent = "--:--";
    return;
  }
  const s = Math.max(0, Math.round((maxScroll() - viewport.scrollTop) / settings.speed));
  const ss = String(s % 60).padStart(2, "0");
  el.textContent =
    s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${ss}`
      : `${Math.floor(s / 60)}:${ss}`;
}

function updateCurrentLine() {
  const rect = viewport.getBoundingClientRect();
  const focusY = rect.top + rect.height * 0.33;
  let currentEl = null;
  for (const el of scriptText.children) {
    const r = el.getBoundingClientRect();
    if (r.top <= focusY && r.bottom >= focusY) {
      currentEl = el;
      break;
    }
    if (r.top > focusY) break;
  }
  for (const el of scriptText.children) {
    el.classList.toggle("current", el === currentEl);
  }
  if (layoutDirty) buildLayout();
  if (!voiceOn || performance.now() < manualUntil) {
    wordIdx = wordFromFocus();
    if (voiceOn) sendVoiceContextSoon();
  }
  showWord(wordIdx);
  renderTimeLeft();
}

function setPlaying(v) {
  playing = v && !!current;
  $("btn-play").textContent = playing ? "Pause" : "Play";
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  $("countdown").classList.add("hidden");
}

function requestPlay() {
  if (editing) return;
  if (countdownTimer) {
    cancelCountdown();
    return;
  }
  if (playing) {
    setPlaying(false);
    savePosition();
    return;
  }
  if (!current) return;
  if (voiceOn) setVoice(false);
  if (!settings.countdown) {
    setPlaying(true);
    return;
  }
  let left = 3;
  const el = $("countdown");
  el.textContent = left;
  el.classList.remove("hidden");
  countdownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      cancelCountdown();
      setPlaying(true);
    } else {
      el.textContent = left;
    }
  }, 1000);
}

// The slider is quadratic so the slow end, where small changes matter most
// for reading, gets most of its travel.
function speedToSlider(v) {
  return Math.round(1000 * Math.sqrt(v / SPEED_MAX));
}

function sliderToSpeed(p) {
  return Math.round(SPEED_MAX * (p / 1000) ** 2);
}

// Hotkey steps shrink at low speeds and snap to the grid of the current
// band, so up then down always returns to the same value.
function stepSpeed(dir) {
  const v = settings.speed;
  if (dir > 0) {
    if (v < 20) return v + 1;
    if (v < 60) return (Math.floor(v / 5) + 1) * 5;
    return (Math.floor(v / 10) + 1) * 10;
  }
  if (v <= 20) return v - 1;
  if (v <= 60) return Math.ceil(v / 5) * 5 - 5;
  return Math.ceil(v / 10) * 10 - 10;
}

function setSpeed(v) {
  settings.speed = clamp(Math.round(v), 0, SPEED_MAX);
  $("speed").value = speedToSlider(settings.speed);
  $("speed-val").textContent = settings.speed;
  renderTimeLeft();
  saveSettingsSoon();
}

function setFontSize(v) {
  settings.fontSize = clamp(v, 16, 64);
  applyUI();
  layoutDirty = true;
  requestAnimationFrame(updateCurrentLine);
  saveSettingsSoon();
}

function setGhostUI(v) {
  ghost = v;
  document.body.classList.toggle("ghost", v);
  $("ghost-banner").classList.toggle("hidden", !v);
  $("btn-ghost").classList.toggle("active", v);
}

function setStealthUI(v) {
  stealth = v;
  $("btn-stealth").classList.toggle("active", v);
  const state = $("stealth-state");
  state.textContent = v ? "hidden from capture" : "VISIBLE to capture";
  state.classList.toggle("off", !v);
}

function setEditingUI(v) {
  editing = v;
  document.body.classList.toggle("editing", v);
  $("editor").classList.toggle("hidden", !v);
  const b = $("btn-edit");
  b.textContent = v ? "Save" : "Edit";
  b.classList.toggle("primary", v);
  $("btn-edit-cancel").classList.toggle("hidden", !v);
}

function enterEdit() {
  if (!current || editing) return;
  if (voiceOn || voiceStarting) setVoice(false);
  cancelCountdown();
  setPlaying(false);
  savePosition();
  $("editor").value = currentRaw;
  setEditingUI(true);
  $("editor").focus();
}

async function saveEdit() {
  if (!current) return;
  const text = $("editor").value;
  try {
    await invoke("write_script", { path: current.path, content: text });
  } catch (err) {
    $("script-title").textContent = "Could not save changes";
    return;
  }
  currentRaw = text;
  renderScript(text);
  $("script-title").textContent = current.name;
  setEditingUI(false);
  requestAnimationFrame(() => {
    const frac = (settings.positions || {})[current.path] || 0;
    viewport.scrollTop = frac * maxScroll();
    updateCurrentLine();
  });
}

function cancelEdit() {
  if (!editing) return;
  setEditingUI(false);
  requestAnimationFrame(updateCurrentLine);
}

function prettyShortcut(s) {
  const mods = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Win" };
  return s
    .split("+")
    .map((part) => {
      const m = mods[part.toLowerCase()];
      if (m) return m;
      if (part.startsWith("Key")) return part.slice(3);
      if (part.startsWith("Digit")) return part.slice(5);
      if (part.startsWith("Arrow")) return part.slice(5);
      if (part.startsWith("Numpad")) return "Num" + part.slice(6);
      return part;
    })
    .join("+");
}

function showHkError(msg) {
  const el = $("hk-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hideHkError() {
  $("hk-error").classList.add("hidden");
}

function endRecord() {
  recording = null;
  window.removeEventListener("keydown", onRecordKey, true);
}

function onRecordKey(e) {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(e.code)) return;
  if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
    endRecord();
    renderHotkeyList();
    return;
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey) {
    showHkError("Include Ctrl, Alt or Win in the combo.");
    return;
  }
  const parts = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("super");
  parts.push(e.code);
  applyHotkey(recording, parts.join("+"));
}

function beginRecord(action, btn) {
  if (recording) endRecord();
  hideHkError();
  recording = action;
  btn.classList.add("recording");
  btn.textContent = "press keys";
  window.addEventListener("keydown", onRecordKey, true);
}

async function applyHotkey(action, combo) {
  endRecord();
  try {
    await invoke("set_hotkey", { action, shortcut: combo });
  } catch (err) {
    showHkError(typeof err === "string" ? err : "Could not set the hotkey.");
    await refreshHotkeys();
    return;
  }
  hideHkError();
  if (!settings.hotkeys) settings.hotkeys = {};
  settings.hotkeys[action] = combo;
  saveSettingsSoon();
  await refreshHotkeys();
}

function renderHotkeyList() {
  const wrap = $("hotkey-list");
  wrap.innerHTML = "";
  for (const [action, label] of HOTKEY_ACTIONS) {
    const row = document.createElement("div");
    row.className = "hk-row";
    const name = document.createElement("span");
    name.className = "hk-label";
    name.textContent = label;
    const btn = document.createElement("button");
    btn.className = "hk-btn";
    const combo = hotkeys.bindings[action] || DEFAULT_HOTKEYS[action];
    btn.textContent = prettyShortcut(combo);
    if (hotkeys.unavailable.includes(action)) {
      btn.classList.add("failed");
      btn.title = "Taken by another app. Click to rebind.";
    } else {
      btn.title = "Click, then press the new keys.";
    }
    btn.addEventListener("click", () => beginRecord(action, btn));
    row.append(name, btn);
    wrap.appendChild(row);
  }
}

async function refreshHotkeys() {
  try {
    hotkeys = await invoke("get_hotkeys");
  } catch (err) {
    hotkeys = { bindings: { ...DEFAULT_HOTKEYS }, unavailable: [] };
  }
  renderHotkeyList();
  const ghostCombo = hotkeys.bindings["toggle-click-through"] || DEFAULT_HOTKEYS["toggle-click-through"];
  $("ghost-hotkey").textContent = prettyShortcut(ghostCombo);
  const b = $("btn-ghost");
  const dead = hotkeys.unavailable.includes("toggle-click-through");
  b.disabled = dead;
  b.title = dead
    ? "Unavailable: another app owns " + prettyShortcut(ghostCombo) + ", which is needed to exit click-through mode. Rebind it in Keys."
    : "Let clicks pass through this window. " + prettyShortcut(ghostCombo) + " restores your mouse.";
}

async function openScript(s) {
  if (voiceOn || voiceStarting) setVoice(false);
  savePosition();
  cancelCountdown();
  let text;
  try {
    text = await invoke("read_script", { path: s.path });
  } catch (err) {
    $("script-title").textContent = "Could not open script";
    return;
  }
  current = s;
  currentRaw = text;
  if (editing) setEditingUI(false);
  $("btn-edit").disabled = false;
  setPlaying(false);
  renderScript(text);
  $("script-title").textContent = s.name;
  settings.lastScript = s.path;
  requestAnimationFrame(() => {
    const frac = (settings.positions || {})[s.path] || 0;
    viewport.scrollTop = frac * maxScroll();
    updateCurrentLine();
  });
  renderList();
  saveSettingsSoon();
}

async function refreshScripts() {
  try {
    scripts = await invoke("list_scripts");
  } catch (err) {
    scripts = [];
  }
  renderList();
}

function renderList() {
  const ul = $("script-list");
  ul.innerHTML = "";
  for (const s of scripts) {
    const li = document.createElement("li");
    if (current && current.path === s.path) li.classList.add("active");
    const name = document.createElement("span");
    name.className = "script-name";
    name.textContent = s.name;
    name.addEventListener("click", () => {
      openScript(s);
      $("sidebar").classList.add("hidden");
    });
    const del = document.createElement("button");
    del.textContent = "x";
    del.title = "Delete";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${s.name}"?`)) return;
      try {
        await invoke("delete_script", { path: s.path });
      } catch (err) {
        return;
      }
      if (current && current.path === s.path) {
        current = null;
        currentRaw = "";
        if (editing) setEditingUI(false);
        $("btn-edit").disabled = true;
        setPlaying(false);
        if (voiceOn) setVoice(false);
        renderScript("");
        $("script-title").textContent = "No script loaded";
        renderTimeLeft();
      }
      await refreshScripts();
    });
    li.append(name, del);
    ul.appendChild(li);
  }
  if (!scripts.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No scripts yet. Paste one or drop .txt / .md files in the folder.";
    ul.appendChild(li);
  }
}

function tick(now) {
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  if (voiceOn && current && wordIdx >= 0 && now >= manualUntil) {
    if (layoutDirty) buildLayout();
    const l = lineOfWord(wordIdx);
    if (l) {
      const target = clamp(l.top + (l.bottom - l.top) / 2 - focusOffset(), 0, maxScroll());
      const diff = target - viewport.scrollTop;
      if (Math.abs(diff) > 0.5) viewport.scrollTop += diff * Math.min(1, dt * 3);
    }
  } else if (playing && current) {
    carry += settings.speed * dt;
    const step = Math.floor(carry);
    if (step >= 1) {
      carry -= step;
      const max = maxScroll();
      viewport.scrollTop = Math.min(viewport.scrollTop + step, max);
      if (viewport.scrollTop >= max - 1) {
        setPlaying(false);
        savePosition();
      }
    }
  }
  requestAnimationFrame(tick);
}

function jump(direction) {
  markManual();
  viewport.scrollBy({ top: direction * viewport.clientHeight * 0.7, behavior: "smooth" });
}

function handleHotkey(action) {
  switch (action) {
    case "toggle-play":
      requestPlay();
      break;
    case "speed-up":
      setSpeed(stepSpeed(1));
      break;
    case "speed-down":
      setSpeed(stepSpeed(-1));
      break;
    case "toggle-voice":
      setVoice(!(voiceOn || voiceStarting));
      break;
    case "answer":
      if ($("answer-pane").classList.contains("hidden")) toggleAnswers();
      ask();
      break;
    case "jump-back":
      jump(-1);
      break;
    case "jump-forward":
      jump(1);
      break;
    case "restart":
      cancelCountdown();
      setPlaying(false);
      viewport.scrollTop = 0;
      savePosition();
      break;
  }
}

function showVoiceStatus(text, isError) {
  const el = $("voice-status");
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
  el.classList.toggle("hidden", !text);
}

// Whisper is primed with the words just read so script vocabulary (names,
// jargon) is recognized instead of guessed. Only words behind the reader:
// on weak audio whisper can echo its prompt, and an echo of words ahead
// would be a perfect match that jumps the script forward.
function sendVoiceContextSoon() {
  if (contextTimer) return;
  contextTimer = setTimeout(() => {
    contextTimer = null;
    if (!voiceOn) return;
    const text = words
      .slice(Math.max(0, wordIdx - 40), wordIdx + 1)
      .map((w) => w.textContent)
      .join(" ");
    invoke("voice_context", { text }).catch(() => {});
  }, 500);
}

async function ensureModel() {
  let status;
  try {
    status = await invoke("model_status", { name: settings.asrModel });
  } catch (err) {
    showVoiceStatus(String(err), true);
    return false;
  }
  if (status.present) return true;
  showVoiceStatus("Download the speech model first (Keys > Speech recognition)", true);
  $("sidebar").classList.add("hidden");
  $("help-pop").classList.remove("hidden");
  return false;
}

async function setVoice(on) {
  if (!on) {
    const wasOn = voiceOn;
    voiceOn = false;
    voiceStarting = false;
    $("btn-voice").classList.remove("active");
    showVoiceStatus("");
    invoke("voice_stop").catch(() => {});
    if (wasOn) savePosition();
    return;
  }
  if (!speechOk || !current || editing || voiceOn || voiceStarting) return;
  voiceStarting = true;
  if (!(await ensureModel())) {
    voiceStarting = false;
    return;
  }
  cancelCountdown();
  setPlaying(false);
  showVoiceStatus("Starting voice follow...");
  try {
    await invoke("voice_start", { model: settings.asrModel, language: settings.asrLang });
  } catch (err) {
    if (voiceStarting) showVoiceStatus("Voice follow failed: " + err, true);
    voiceStarting = false;
    return;
  }
  // A stop requested while the model loaded clears voiceStarting.
  if (!voiceStarting) {
    invoke("voice_stop").catch(() => {});
    return;
  }
  voiceStarting = false;
  voiceOn = true;
  $("btn-voice").classList.add("active");
  if (wordIdx < 0) wordIdx = Math.max(0, wordFromFocus());
  showWord(wordIdx);
  sendVoiceContextSoon();
  showVoiceStatus("Voice follow: read aloud, the script keeps up");
}

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

function sameWord(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return editDistanceAtMost(a, b, a.length >= 8 ? 2 : 1);
}

// Walks the heard words backwards from script position p, allowing a
// couple of skipped script words per step (the reader drops or the
// recognizer misses short words). Returns matches minus skip penalties.
function scoreAt(tail, p) {
  let i = p;
  let matches = 0;
  let penalty = 0;
  for (let k = tail.length - 1; k >= 0 && i >= 0; k--) {
    let found = -1;
    for (let d = 0; d < 3 && i - d >= 0; d++) {
      if (sameWord(tail[k], normWords[i - d])) {
        found = i - d;
        break;
      }
    }
    if (found >= 0) {
      matches++;
      penalty += (i - found) * 0.5;
      i = found - 1;
    } else if (k === tail.length - 1) {
      penalty += 1;
    }
  }
  return { matches, value: matches - penalty };
}

// The recognizer re-reads the last few seconds, so the end of its text is
// what was just said. Only a window around the current word is searched,
// which keeps a repeated phrase elsewhere in the script from stealing the
// position; jumping backwards needs a stronger match than moving ahead.
function alignHeard(text) {
  if (!normWords.length) return;
  const tail = text.split(/\s+/).map(normalizeWord).filter(Boolean).slice(-8);
  if (tail.length < 2) return;
  const from = Math.max(0, wordIdx - 12);
  const to = Math.min(normWords.length - 1, Math.max(wordIdx, 0) + 60);
  let best = -1;
  let bestScore = null;
  for (let p = from; p <= to; p++) {
    const sc = scoreAt(tail, p);
    const value = sc.value - Math.abs(p - wordIdx) * 0.01;
    if (!bestScore || value > bestScore.value) {
      best = p;
      bestScore = { matches: sc.matches, value };
    }
  }
  if (!bestScore || bestScore.matches < Math.min(3, tail.length) || bestScore.value < 2) return;
  const next = Math.min(best + 1, normWords.length - 1);
  if (next < wordIdx - 1 && bestScore.matches < 4) return;
  wordIdx = next;
  showWord(wordIdx);
  sendVoiceContextSoon();
}

function onAsr(p) {
  if (p.source === "mic") {
    if (voiceOn && performance.now() >= manualUntil) alignHeard(p.text);
  } else if (p.source === "sys") {
    const heard = $("heard");
    const line = document.createElement("div");
    line.textContent = p.text;
    heard.appendChild(line);
    while (heard.children.length > 3) heard.firstChild.remove();
    heard.classList.remove("hidden");
  }
}

async function setListen(on) {
  if (!on) {
    listenOn = false;
    listenStarting = false;
    $("btn-listen").classList.remove("active");
    invoke("listen_stop").catch(() => {});
    return;
  }
  if (!speechOk || listenOn || listenStarting) return;
  listenStarting = true;
  if (!(await ensureModel())) {
    listenStarting = false;
    return;
  }
  try {
    await invoke("listen_start", { model: settings.asrModel, language: settings.asrLang });
  } catch (err) {
    if (listenStarting) showAnswerError("Listen failed: " + err);
    listenStarting = false;
    return;
  }
  if (!listenStarting) {
    invoke("listen_stop").catch(() => {});
    return;
  }
  listenStarting = false;
  listenOn = true;
  $("btn-listen").classList.add("active");
}

function toggleAnswers() {
  const pane = $("answer-pane");
  pane.classList.toggle("hidden");
  const open = !pane.classList.contains("hidden");
  document.body.classList.toggle("answers", open);
  $("btn-answers").classList.toggle("active", open);
}

function providerCfg() {
  const id = PROVIDERS[settings.ai.provider] ? settings.ai.provider : "lmstudio";
  const preset = PROVIDERS[id];
  const o = settings.ai.providers[id] || {};
  return {
    id,
    kind: preset.kind,
    base_url: o.url || preset.url,
    model: o.model !== undefined ? o.model : preset.model,
  };
}

function saveProviderField(field, value) {
  const id = providerCfg().id;
  settings.ai.providers[id] = { ...(settings.ai.providers[id] || {}), [field]: value };
  saveSettingsSoon();
}

async function refreshKeyState() {
  const p = providerCfg();
  let has = false;
  try {
    has = await invoke("llm_has_key", { id: p.id });
  } catch (err) {}
  $("ai-key-state").textContent = has
    ? "A key is saved in the system keychain. Save an empty field to remove it."
    : p.kind === "anthropic"
      ? "No key saved yet. Claude needs one."
      : "No key saved.";
}

function loadAiUI() {
  settings.ai = { ...DEFAULTS.ai, ...(settings.ai || {}) };
  settings.ai.providers = { ...(settings.ai.providers || {}) };
  const p = providerCfg();
  $("ai-provider").value = p.id;
  $("ai-url").value = p.base_url;
  $("ai-model").value = p.model;
  $("ai-key").value = "";
  $("ai-include-script").checked = !!settings.ai.includeScript;
  $("ai-notes").value = settings.ai.notes || "";
  $("ai-model-list").innerHTML = "";
  refreshKeyState();
}

function showAnswerError(msg) {
  const out = $("answer-out");
  out.textContent = msg;
  out.classList.add("error");
}

async function ask() {
  const seq = ++answerSeq;
  const out = $("answer-out");
  out.classList.remove("error");
  const typed = $("ask-input").value.trim();
  let heard = "";
  if (speechOk) {
    try {
      heard = await invoke("transcript_recent", { seconds: 90 });
    } catch (err) {}
  }
  if (!typed && !heard) {
    showAnswerError("Nothing heard yet. Turn on Listen, or type the question.");
    return;
  }
  const parts = [];
  if (settings.ai.includeScript && currentRaw) parts.push(`<script>\n${currentRaw}\n</script>`);
  if (settings.ai.notes && settings.ai.notes.trim()) parts.push(`<notes>\n${settings.ai.notes}\n</notes>`);
  if (heard) parts.push(`<heard>\n${heard}\n</heard>`);
  if (typed) parts.push(`<question>\n${typed}\n</question>`);
  parts.push(
    typed
      ? "Suggest answers to the question above."
      : "Suggest answers to the most recent question asked of the presenter in the heard transcript.",
  );
  out.textContent = "Thinking...";
  let first = true;
  const ch = new Channel();
  ch.onmessage = (m) => {
    if (seq !== answerSeq || m.type !== "delta") return;
    if (first) {
      out.textContent = "";
      first = false;
    }
    out.textContent += m.text;
    out.scrollTop = out.scrollHeight;
  };
  try {
    await invoke("llm_answer", {
      provider: providerCfg(),
      system: ANSWER_SYSTEM,
      prompt: parts.join("\n\n"),
      seq,
      onEvent: ch,
    });
    if (seq === answerSeq && first) showAnswerError("The model returned no text.");
  } catch (err) {
    if (seq === answerSeq) showAnswerError(String(err));
  }
}

function wireAnswers() {
  $("btn-answers").addEventListener("click", toggleAnswers);
  $("btn-ask").addEventListener("click", ask);
  $("ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ask();
    }
  });
  $("btn-listen").addEventListener("click", () => setListen(!(listenOn || listenStarting)));
  $("btn-ai-setup").addEventListener("click", () => {
    $("ai-setup").classList.toggle("hidden");
    $("btn-ai-setup").classList.toggle("active", !$("ai-setup").classList.contains("hidden"));
  });
  $("ai-provider").addEventListener("change", (e) => {
    settings.ai.provider = e.target.value;
    saveSettingsSoon();
    loadAiUI();
  });
  $("ai-url").addEventListener("change", (e) => saveProviderField("url", e.target.value.trim()));
  $("ai-model").addEventListener("change", (e) => saveProviderField("model", e.target.value.trim()));
  $("btn-ai-models").addEventListener("click", async () => {
    const b = $("btn-ai-models");
    b.disabled = true;
    try {
      const ids = await invoke("llm_models", { provider: providerCfg() });
      const list = $("ai-model-list");
      list.innerHTML = "";
      for (const id of ids) {
        const o = document.createElement("option");
        o.value = id;
        list.appendChild(o);
      }
      $("ai-key-state").textContent = ids.length
        ? `${ids.length} models found. Pick one in the Model field.`
        : "The server listed no models.";
    } catch (err) {
      $("ai-key-state").textContent = String(err);
    }
    b.disabled = false;
  });
  $("btn-ai-key").addEventListener("click", async () => {
    try {
      await invoke("llm_set_key", { id: providerCfg().id, key: $("ai-key").value });
      $("ai-key").value = "";
      await refreshKeyState();
    } catch (err) {
      $("ai-key-state").textContent = "Could not save the key: " + err;
    }
  });
  $("ai-include-script").addEventListener("change", (e) => {
    settings.ai.includeScript = e.target.checked;
    saveSettingsSoon();
  });
  $("ai-notes").addEventListener("input", (e) => {
    settings.ai.notes = e.target.value;
    saveSettingsSoon();
  });
  $("btn-transcript-clear").addEventListener("click", () => {
    invoke("transcript_clear").catch(() => {});
    $("heard").innerHTML = "";
    $("heard").classList.add("hidden");
  });
}

async function refreshAsrState() {
  if (!speechOk) return;
  $("asr-model").value = settings.asrModel;
  $("asr-lang").value = settings.asrLang;
  let present = false;
  try {
    present = (await invoke("model_status", { name: settings.asrModel })).present;
  } catch (err) {}
  $("asr-state").textContent = present ? "Model ready" : "Model not downloaded";
  $("btn-asr-download").classList.toggle("hidden", present);
}

function wireSpeechSetup() {
  $("asr-model").addEventListener("change", (e) => {
    settings.asrModel = e.target.value;
    saveSettingsSoon();
    refreshAsrState();
  });
  $("asr-lang").addEventListener("change", (e) => {
    settings.asrLang = e.target.value;
    saveSettingsSoon();
  });
  $("btn-asr-download").addEventListener("click", async () => {
    const b = $("btn-asr-download");
    const state = $("asr-state");
    b.disabled = true;
    const ch = new Channel();
    ch.onmessage = (pct) => {
      state.textContent = `Downloading ${pct}%`;
    };
    state.textContent = "Downloading...";
    try {
      await invoke("download_model", { name: settings.asrModel, progress: ch });
      showVoiceStatus("");
    } catch (err) {
      state.textContent = "Download failed: " + err;
      b.disabled = false;
      return;
    }
    b.disabled = false;
    refreshAsrState();
  });
}

function wireControls() {
  $("btn-play").addEventListener("click", requestPlay);
  $("btn-restart").addEventListener("click", () => {
    if (editing) return;
    cancelCountdown();
    setPlaying(false);
    viewport.scrollTop = 0;
    savePosition();
  });
  $("btn-edit").addEventListener("click", () => {
    if (editing) {
      saveEdit();
    } else {
      enterEdit();
    }
  });
  $("btn-edit-cancel").addEventListener("click", cancelEdit);
  $("editor").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      saveEdit();
    }
  });
  $("btn-theme").addEventListener("click", () => {
    settings.theme = settings.theme === "light" ? "dark" : "light";
    applyUI();
    saveSettingsSoon();
  });
  $("speed").addEventListener("input", (e) => setSpeed(sliderToSpeed(Number(e.target.value))));
  $("btn-words").addEventListener("click", () => {
    settings.wordHighlight = !settings.wordHighlight;
    applyUI();
    showWord(wordIdx);
    saveSettingsSoon();
  });
  $("btn-voice").addEventListener("click", () => setVoice(!(voiceOn || voiceStarting)));
  wireAnswers();
  wireSpeechSetup();
  $("opacity").addEventListener("input", (e) => {
    settings.opacity = Number(e.target.value);
    applyUI();
    saveSettingsSoon();
  });
  $("font-minus").addEventListener("click", () => setFontSize(settings.fontSize - 2));
  $("font-plus").addEventListener("click", () => setFontSize(settings.fontSize + 2));
  $("btn-count").addEventListener("click", () => {
    settings.countdown = !settings.countdown;
    $("btn-count").classList.toggle("active", !!settings.countdown);
    saveSettingsSoon();
  });

  $("btn-ghost").addEventListener("click", () => {
    invoke("set_click_through", { enabled: !ghost }).catch(() => {});
  });
  $("btn-stealth").addEventListener("click", () => {
    const next = !stealth;
    invoke("set_capture_protection", { enabled: next })
      .then(() => setStealthUI(next))
      .catch(() => {});
  });

  $("btn-scripts").addEventListener("click", () => {
    $("help-pop").classList.add("hidden");
    $("sidebar").classList.toggle("hidden");
  });
  $("btn-help").addEventListener("click", () => {
    $("sidebar").classList.add("hidden");
    $("help-pop").classList.toggle("hidden");
    if ($("help-pop").classList.contains("hidden") && recording) {
      endRecord();
    }
  });
  $("btn-close").addEventListener("click", async () => {
    savePosition();
    clearTimeout(saveTimer);
    try {
      await invoke("save_settings", { settings });
    } catch (err) {}
    appWindow.close();
  });

  $("hk-reset").addEventListener("click", async () => {
    hideHkError();
    if (recording) endRecord();
    for (const [action] of HOTKEY_ACTIONS) {
      try {
        await invoke("set_hotkey", { action, shortcut: DEFAULT_HOTKEYS[action] });
      } catch (err) {}
    }
    settings.hotkeys = {};
    saveSettingsSoon();
    await refreshHotkeys();
  });

  $("btn-update").addEventListener("click", async () => {
    const b = $("btn-update");
    b.disabled = true;
    b.textContent = "Installing...";
    try {
      await invoke("install_update");
    } catch (err) {
      b.disabled = false;
      b.textContent = "Update failed - retry";
    }
  });

  $("btn-refresh").addEventListener("click", refreshScripts);
  $("btn-folder").addEventListener("click", () => {
    invoke("open_scripts_folder").catch(() => {});
  });
  $("btn-new").addEventListener("click", () => {
    $("paste-modal").classList.remove("hidden");
    $("paste-name").focus();
  });
  $("paste-cancel").addEventListener("click", () => {
    $("paste-modal").classList.add("hidden");
  });
  $("paste-save").addEventListener("click", async () => {
    const content = $("paste-content").value;
    if (!content.trim()) return;
    let info;
    try {
      info = await invoke("save_script", { name: $("paste-name").value, content });
    } catch (err) {
      return;
    }
    $("paste-modal").classList.add("hidden");
    $("paste-name").value = "";
    $("paste-content").value = "";
    await refreshScripts();
    await openScript(info);
  });

  viewport.addEventListener("wheel", markManual, { passive: true });
  new ResizeObserver(() => {
    layoutDirty = true;
    requestAnimationFrame(updateCurrentLine);
  }).observe(viewport);

  viewport.addEventListener("scroll", () => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      updateCurrentLine();
    });
  });

  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    markManual();
    if (e.code === "Space") {
      e.preventDefault();
      requestPlay();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      viewport.scrollTop += 60;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      viewport.scrollTop -= 60;
    } else if (e.key === "PageDown") {
      e.preventDefault();
      jump(1);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      jump(-1);
    } else if (e.key === "Home") {
      viewport.scrollTop = 0;
    } else if (e.key === "End") {
      viewport.scrollTop = viewport.scrollHeight;
    }
  });
}

async function init() {
  try {
    const stored = await invoke("load_settings");
    settings = { ...DEFAULTS, ...stored };
  } catch (err) {
    settings = { ...DEFAULTS };
  }
  applyUI();
  setStealthUI(true);
  wireControls();

  await listen("hotkey", (e) => handleHotkey(e.payload));
  await listen("asr", (e) => onAsr(e.payload));
  await listen("asr-error", (e) => {
    if (e.payload.source === "mic") {
      setVoice(false);
      showVoiceStatus("Microphone stopped: " + e.payload.text, true);
    } else {
      setListen(false);
      showAnswerError("Listening stopped: " + e.payload.text);
    }
  });
  await listen("click-through-changed", (e) => setGhostUI(e.payload));
  await listen("update-available", (e) => {
    const b = $("btn-update");
    b.textContent = "Update to v" + e.payload;
    b.classList.remove("hidden");
  });

  await refreshHotkeys();

  try {
    speechOk = await invoke("speech_supported");
  } catch (err) {
    speechOk = false;
  }
  for (const id of ["btn-voice", "btn-listen", "speech-setup"]) {
    $(id).classList.toggle("hidden", !speechOk);
  }
  loadAiUI();
  refreshAsrState();

  await refreshScripts();
  const last = scripts.find((s) => s.path === settings.lastScript);
  if (last) {
    await openScript(last);
  } else if (scripts.length) {
    await openScript(scripts[0]);
  }

  setInterval(() => {
    if (current && ((playing && settings.speed > 0) || voiceOn)) savePosition();
  }, 3000);

  requestAnimationFrame(tick);
}

init();
