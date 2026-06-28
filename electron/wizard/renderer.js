"use strict";

/**
 * Setup wizard renderer — provider-aware, one coherent "connect" step per
 * backend, and the Continue button is gated until that backend is actually
 * verified, so the wizard never closes on a config that errors later:
 *   • codex  → in-app ChatGPT/OpenAI browser OAuth; Continue when signed in.
 *   • claude → in-app Anthropic browser OAuth; Continue when signed in.
 *   • gemini → API key (Google retired free-tier OAuth); Continue runs a real
 *              test call against the key first.
 *   • pi     → BYOK configured inline (preset + URL + key + model); Continue
 *              runs a real test call against the endpoint first.
 */

const els = {
  radiosProvider: document.querySelectorAll("input[name='provider']"),
  stepInstall: document.getElementById("step-install"),
  stepInstallMarker: document.getElementById("step-install-marker"),
  stepLogin: document.getElementById("step-login"),
  stepLoginMarker: document.getElementById("step-login-marker"),
  loginTitle: document.querySelector("#step-login h2"),
  headerBlurb: document.getElementById("header-blurb"),
  installDesc: document.getElementById("install-desc"),
  installStatus: document.getElementById("install-status"),
  btnInstall: document.getElementById("btn-install"),
  loginDesc: document.getElementById("login-desc"),
  loginStatus: document.getElementById("login-status"),
  btnLogin: document.getElementById("btn-login"),
  apiKeyBox: document.getElementById("api-key-box"),
  apiKeyInput: document.getElementById("api-key-input"),
  keyHelp: document.getElementById("key-help"),
  keyLink: document.getElementById("key-link"),
  byokBox: document.getElementById("byok-box"),
  byokPreset: document.getElementById("byok-preset"),
  byokUrl: document.getElementById("byok-url"),
  byokKey: document.getElementById("byok-key"),
  byokModel: document.getElementById("byok-model"),
  codeBox: document.getElementById("code-box"),
  codeInput: document.getElementById("code-input"),
  btnSubmitCode: document.getElementById("btn-submit-code"),
  btnFinish: document.getElementById("btn-finish"),
  btnCancel: document.getElementById("btn-cancel"),
  platformInfo: document.getElementById("platform-info"),
  authUrlBox: document.getElementById("auth-url-box"),
  authUrl: document.getElementById("auth-url"),
  btnOpenUrl: document.getElementById("btn-open-url"),
};

const PROVIDER_LABEL = {
  codex: "Codex CLI (OpenAI)",
  gemini: "Gemini",
  claude: "Claude",
  pi: "your own key",
};

const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";

// BYOK presets — same mapping as Settings, so the two stay consistent.
const BYOK_PRESETS = {
  ollama: { url: "http://localhost:11434/v1", apiType: "openai-completions", model: "qwen2.5-coder:7b", needsKey: false },
  openai: { url: "https://api.openai.com/v1", apiType: "openai-completions", model: "gpt-4o-mini", needsKey: true },
  anthropic: { url: "https://api.anthropic.com", apiType: "anthropic-messages", model: "claude-3-5-haiku", needsKey: true },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta", apiType: "google-generative-ai", model: "gemini-2.5-flash", needsKey: true },
  custom: { url: "", apiType: "openai-completions", model: "", needsKey: true },
};

let lastStatus = {};
let selectedProvider = "codex";
let lastAuthUrl = null;
let claudeConnected = false;
let verifying = false;
let verifyError = null;

// Open on the provider we were told to (switch / re-auth / saved choice).
try {
  const wanted = new URLSearchParams(location.search).get("provider");
  if (wanted && ["codex", "gemini", "claude", "pi"].includes(wanted)) {
    selectedProvider = wanted;
    const radio = document.querySelector(`input[name='provider'][value='${wanted}']`);
    if (radio) radio.checked = true;
  }
} catch { /* default to codex */ }

els.radiosProvider.forEach((r) => {
  r.addEventListener("change", (e) => {
    if (e.target.checked) {
      selectedProvider = e.target.value;
      verifyError = null;
      if (selectedProvider !== "claude") claudeConnected = false;
      if (selectedProvider === "pi") applyByokPreset(els.byokPreset.value || "ollama");
      render();
    }
  });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function applyByokPreset(preset) {
  const p = BYOK_PRESETS[preset] || BYOK_PRESETS.custom;
  els.byokUrl.value = p.url;
  els.byokModel.value = p.model;
  els.byokKey.placeholder = p.needsKey ? "API key (required)" : "API key (not needed for Ollama)";
}

function byokConfig() {
  const preset = els.byokPreset.value || "ollama";
  const p = BYOK_PRESETS[preset] || BYOK_PRESETS.custom;
  return {
    piProvider: preset,
    piUrl: els.byokUrl.value.trim(),
    piApiKey: els.byokKey.value.trim(),
    piApiType: p.apiType,
    piModelFast: els.byokModel.value.trim() || "llama3.2",
    piModelSmart: els.byokModel.value.trim() || "llama3.2",
  };
}

/** Is the selected provider ready to finish (before the verify call)? */
function providerReady() {
  if (selectedProvider === "codex") return !!(lastStatus.binaryFound && lastStatus.versionOk && lastStatus.loggedIn);
  if (selectedProvider === "claude") return claudeConnected || !!lastStatus.claudeLoggedIn;
  if (selectedProvider === "gemini") return !!els.apiKeyInput.value.trim();
  if (selectedProvider === "pi") {
    const preset = els.byokPreset.value || "ollama";
    const needsKey = (BYOK_PRESETS[preset] || BYOK_PRESETS.custom).needsKey;
    return !!els.byokUrl.value.trim() && (!needsKey || !!els.byokKey.value.trim());
  }
  return false;
}

function hideAll() {
  els.apiKeyBox.hidden = true;
  els.keyHelp.hidden = true;
  els.byokBox.hidden = true;
  els.byokBox.style.display = "none";
  els.codeBox.hidden = true;
  els.btnLogin.hidden = true;
  els.authUrlBox.hidden = true;
  els.loginStatus.innerHTML = "";
}

function render() {
  const s = lastStatus || {};
  const phase = s.phase ?? "idle";
  const isCodex = selectedProvider === "codex";
  const codexReady = !!(s.binaryFound && s.versionOk);
  const showInstall = isCodex && !codexReady;

  els.platformInfo.textContent = isCodex && s.targetTriple
    ? `Platform: ${s.targetTriple}  ·  Required: ≥ ${s.requiredVersion}`
    : "";

  els.stepInstall.hidden = !showInstall;
  els.stepLoginMarker.textContent = showInstall ? "3" : "2";
  els.headerBlurb.textContent =
    "Connect " + (PROVIDER_LABEL[selectedProvider] || "a provider") +
    " to power Get It.'s agents. Your study data never leaves this Mac/PC.";

  if (showInstall) {
    els.stepInstall.classList.toggle("active", phase !== "installing");
    els.stepInstall.classList.toggle("error", phase === "error" && !s.binaryFound);
    els.installDesc.textContent = s.binaryFound
      ? `The Codex CLI on this machine is ${s.version ?? "an unknown version"}; Get It. needs ≥ ${s.requiredVersion}.`
      : `Get It.'s bundled Codex CLI ${s.requiredVersion} is missing on this machine. Install a fresh copy — one-time download, ~30 MB.`;
    els.btnInstall.textContent = s.binaryFound ? "Update Codex CLI" : "Install Codex CLI";
    els.btnInstall.disabled = phase === "installing";
    els.installStatus.innerHTML =
      phase === "installing"
        ? `<span class="spinner"></span>${escapeHtml(s.message || "Installing…")}`
        : phase === "error" && !s.binaryFound
          ? `<span class="err">${escapeHtml(s.message || "Failed.")}</span>`
          : "";
  }

  // ── Connect step (provider-specific)
  hideAll();
  const loggingIn = phase === "logging-in";

  if (selectedProvider === "gemini") {
    els.loginTitle.textContent = "Add your Gemini API key";
    els.loginDesc.innerHTML =
      "Google now requires an API key for the Gemini Developer API (the free browser login was retired). Paste a key — it's stored only on this device and verified before you continue.";
    els.apiKeyBox.hidden = false;
    els.keyHelp.hidden = false;
    els.keyLink.textContent = "Get a free key from Google AI Studio";
    els.apiKeyInput.placeholder = "AIzaSy… (Gemini API key)";
  } else if (selectedProvider === "pi") {
    els.loginTitle.textContent = "Bring your own key";
    els.loginDesc.innerHTML =
      "Pick a backend, paste your key, and we'll verify the connection before continuing.";
    els.byokBox.hidden = false;
    els.byokBox.style.display = "flex";
  } else if (selectedProvider === "claude") {
    els.loginTitle.textContent = "Sign in with Claude";
    els.loginDesc.innerHTML =
      "One click — a browser window opens. Finish signing in there and this continues automatically. <span class=\"muted\">(Only paste a code below if your browser asks for one.)</span>";
    if (claudeConnected || s.claudeLoggedIn) {
      els.stepLogin.classList.add("done");
      els.stepLogin.classList.remove("active", "error");
      els.loginStatus.innerHTML = `<span class="ok">✓ Connected</span>`;
      els.btnLogin.hidden = false;
      els.btnLogin.disabled = true;
      els.btnLogin.textContent = "Signed in";
    } else {
      els.stepLogin.classList.add("active");
      els.stepLogin.classList.toggle("error", phase === "error");
      els.btnLogin.hidden = false;
      els.btnLogin.disabled = loggingIn;
      els.btnLogin.textContent = loggingIn ? "Waiting…" : "Sign in with Claude";
      els.codeBox.hidden = !loggingIn;
      if (loggingIn) {
        els.loginStatus.innerHTML = `<span class="spinner"></span>${escapeHtml(s.message || "Waiting for browser sign-in…")}`;
      } else if (phase === "error") {
        els.loginStatus.innerHTML = `<span class="err">${escapeHtml(s.message || "Login didn't complete.")}</span>`;
      }
    }
  } else {
    // codex
    els.loginTitle.textContent = "Sign in with ChatGPT or OpenAI";
    if (!codexReady) {
      els.loginDesc.textContent = "Install the Codex CLI above first.";
      els.btnLogin.hidden = false;
      els.btnLogin.disabled = true;
      els.btnLogin.textContent = "Sign in with ChatGPT";
    } else if (s.loggedIn) {
      els.loginDesc.textContent = "You're signed in to Codex.";
      els.stepLogin.classList.add("done");
      els.loginStatus.innerHTML = `<span class="ok">✓ Connected</span>`;
      els.btnLogin.hidden = false;
      els.btnLogin.disabled = true;
      els.btnLogin.textContent = "Signed in";
    } else {
      els.loginDesc.textContent =
        "A browser window opens to authenticate — the same login Codex itself uses. This dialog continues automatically once you're done.";
      els.stepLogin.classList.add("active");
      els.stepLogin.classList.toggle("error", phase === "error");
      els.btnLogin.hidden = false;
      els.btnLogin.disabled = loggingIn;
      els.btnLogin.textContent = "Sign in with ChatGPT";
      els.loginStatus.innerHTML = loggingIn
        ? `<span class="spinner"></span>${escapeHtml(s.message || "Waiting for browser…")}`
        : phase === "error"
          ? `<span class="err">${escapeHtml(s.message || "Login failed.")}</span>`
          : "";
    }
  }

  // Verify status (gemini / pi) overrides the connect-step status line.
  if (verifying) {
    els.loginStatus.innerHTML = `<span class="spinner"></span>Verifying connection…`;
  } else if (verifyError) {
    els.loginStatus.innerHTML = `<span class="err">${escapeHtml(verifyError)}</span>`;
  }

  // Auth-URL fallback (codex + claude during login)
  if (s.authUrl && loggingIn && (isCodex || selectedProvider === "claude")) {
    lastAuthUrl = s.authUrl;
    els.authUrlBox.hidden = false;
    els.authUrl.textContent = s.authUrl;
  } else {
    lastAuthUrl = null;
  }

  // ── Continue gate: only when the provider is set up (and not mid-verify).
  els.btnFinish.disabled = verifying || !providerReady();
  els.btnFinish.textContent = verifying ? "Verifying…" : "Continue";
}

// ── Buttons ─────────────────────────────────────────────────────────────
els.btnInstall.addEventListener("click", async () => {
  els.btnInstall.disabled = true;
  await window.wizard.install();
});

els.btnLogin.addEventListener("click", async () => {
  els.btnLogin.disabled = true;
  const res = await window.wizard.login(selectedProvider);
  if (selectedProvider === "claude") {
    if (res && res.ok) claudeConnected = true;
    render();
  }
});

els.btnSubmitCode.addEventListener("click", async () => {
  const code = els.codeInput.value.trim();
  if (code) await window.wizard.submitCode(code);
});

els.keyLink.addEventListener("click", (e) => {
  e.preventDefault();
  window.wizard.openUrl(GEMINI_KEY_URL);
});

els.byokPreset.addEventListener("change", () => {
  applyByokPreset(els.byokPreset.value);
  verifyError = null;
  render();
});
[els.apiKeyInput, els.byokUrl, els.byokKey, els.byokModel].forEach((el) => {
  el.addEventListener("input", () => {
    verifyError = null;
    render();
  });
});

els.btnFinish.addEventListener("click", async () => {
  // gemini / pi: verify the real connection before closing.
  if (selectedProvider === "gemini" || selectedProvider === "pi") {
    verifying = true;
    verifyError = null;
    render();
    let res;
    try {
      if (selectedProvider === "gemini") {
        res = await window.wizard.verify({ provider: "gemini", geminiApiKey: els.apiKeyInput.value.trim() });
      } else {
        res = await window.wizard.verify({ provider: "pi", pi: byokConfig() });
      }
    } catch (e) {
      res = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    verifying = false;
    if (!res || !res.ok) {
      verifyError = (res && res.error) || "Couldn't connect — check your key/endpoint and try again.";
      render();
      return;
    }
  }

  const payload = { provider: selectedProvider };
  if (selectedProvider === "gemini") payload.geminiApiKey = els.apiKeyInput.value.trim();
  if (selectedProvider === "pi") payload.pi = byokConfig();
  await window.wizard.finish(payload);
});

els.btnCancel.addEventListener("click", () => window.wizard.cancel());
els.btnOpenUrl.addEventListener("click", () => {
  if (lastAuthUrl) window.wizard.openUrl(lastAuthUrl);
});

// ── Live status from main ───────────────────────────────────────────────
window.wizard.onStatus((s) => {
  lastStatus = s || {};
  render();
});
window.wizard.status().then((s) => {
  lastStatus = s || {};
  if (selectedProvider === "pi") applyByokPreset(els.byokPreset.value || "ollama");
  render();
});
