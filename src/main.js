const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const scriptText = $("script-text");

const DEFAULTS = { fontSize: 30, opacity: 85, speed: 60, lastScript: null, positions: {} };

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
}

function setPlaying(v) {
  playing = v && !!current;
  $("btn-play").textContent = playing ? "Pause" : "Play";
}

function setSpeed(v) {
  settings.speed = clamp(Math.round(v), 10, 300);
  $("speed").value = settings.speed;
  $("speed-val").textContent = settings.speed;
  saveSettingsSoon();
}

function setFontSize(v) {
  settings.fontSize = clamp(v, 16, 64);
  applyUI();
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

async function openScript(s) {
  savePosition();
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
      setPlaying(!playing);
      if (!playing) savePosition();
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
      setPlaying(false);
      viewport.scrollTop = 0;
      savePosition();
      break;
  }
}

function wireControls() {
  $("btn-play").addEventListener("click", () => {
    setPlaying(!playing);
    if (!playing) savePosition();
  });
  $("btn-restart").addEventListener("click", () => {
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
  });
  $("btn-close").addEventListener("click", async () => {
    savePosition();
    clearTimeout(saveTimer);
    try {
      await invoke("save_settings", { settings });
    } catch (err) {}
    appWindow.close();
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
      setPlaying(!playing);
      if (!playing) savePosition();
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

  try {
    const unavailable = await invoke("get_unavailable_hotkeys");
    if (unavailable.includes("toggle-click-through")) {
      // Without the escape hotkey, enabling click-through would lock the
      // user out of their own window.
      const b = $("btn-ghost");
      b.disabled = true;
      b.title = "Unavailable: another app owns Ctrl+Alt+G, which is needed to exit click-through mode.";
    }
  } catch (err) {}

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
