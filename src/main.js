const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
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
};

const DEFAULT_HOTKEYS = {
  "toggle-play": "ctrl+alt+Space",
  "speed-up": "ctrl+alt+ArrowUp",
  "speed-down": "ctrl+alt+ArrowDown",
  "jump-back": "ctrl+alt+ArrowLeft",
  "jump-forward": "ctrl+alt+ArrowRight",
  "restart": "ctrl+alt+Home",
  "toggle-visibility": "ctrl+alt+KeyH",
  "toggle-click-through": "ctrl+alt+KeyG",
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
  $("speed").value = settings.speed;
  $("speed-val").textContent = settings.speed;
  $("opacity").value = settings.opacity;
  $("btn-count").classList.toggle("active", !!settings.countdown);
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
  const s = Math.max(0, Math.round((maxScroll() - viewport.scrollTop) / settings.speed));
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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

function setSpeed(v) {
  settings.speed = clamp(Math.round(v), 10, 300);
  $("speed").value = settings.speed;
  $("speed-val").textContent = settings.speed;
  renderTimeLeft();
  saveSettingsSoon();
}

function setFontSize(v) {
  settings.fontSize = clamp(v, 16, 64);
  applyUI();
  requestAnimationFrame(renderTimeLeft);
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
  setPlaying(false);
  scriptText.innerHTML = mdLite(text);
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
        setPlaying(false);
        scriptText.innerHTML = "";
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
  if (playing && current) {
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
  viewport.scrollBy({ top: direction * viewport.clientHeight * 0.7, behavior: "smooth" });
}

function handleHotkey(action) {
  switch (action) {
    case "toggle-play":
      requestPlay();
      break;
    case "speed-up":
      setSpeed(settings.speed + 10);
      break;
    case "speed-down":
      setSpeed(settings.speed - 10);
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

function wireControls() {
  $("btn-play").addEventListener("click", requestPlay);
  $("btn-restart").addEventListener("click", () => {
    cancelCountdown();
    setPlaying(false);
    viewport.scrollTop = 0;
    savePosition();
  });
  $("speed").addEventListener("input", (e) => setSpeed(Number(e.target.value)));
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
    if (tag === "INPUT" || tag === "TEXTAREA") return;
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
  await listen("click-through-changed", (e) => setGhostUI(e.payload));
  await listen("update-available", (e) => {
    const b = $("btn-update");
    b.textContent = "Update to v" + e.payload;
    b.classList.remove("hidden");
  });

  await refreshHotkeys();

  await refreshScripts();
  const last = scripts.find((s) => s.path === settings.lastScript);
  if (last) {
    await openScript(last);
  } else if (scripts.length) {
    await openScript(scripts[0]);
  }

  setInterval(() => {
    if (current && playing) savePosition();
  }, 3000);

  requestAnimationFrame(tick);
}

init();
