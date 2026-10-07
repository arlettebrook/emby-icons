const form = document.querySelector("#submission-form");
const button = document.querySelector("#submit-button");
const result = document.querySelector("#result");
const nameInput = document.querySelector("#name");
const nameHint = document.querySelector("#name-hint");
let turnstileToken = "";

function showResult(message, error = false) {
  result.hidden = false;
  result.textContent = message;
  result.classList.toggle("error", error);
}

function showSubmissionSuccess(submission, accessToken) {
  result.hidden = false;
  result.classList.remove("error");
  result.replaceChildren();

  const message = document.createElement("div");
  message.textContent = `提交成功，编号：${submission.id}`;
  const explanation = document.createElement("span");
  explanation.className = "credential-note";
  explanation.textContent = "访问凭证用于查看状态、修改或撤回这条提交。编号只能定位记录，不能代替访问凭证。";
  const actions = document.createElement("div");
  actions.className = "credential-actions";

  const statusLink = document.createElement("a");
  statusLink.className = "button button-secondary";
  statusLink.href = `/submission.html?id=${encodeURIComponent(submission.id)}`;
  statusLink.textContent = "查看提交状态";
  const copyButton = document.createElement("button");
  copyButton.className = "button button-secondary";
  copyButton.type = "button";
  copyButton.textContent = "复制访问凭证";
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(accessToken);
      copyButton.textContent = "已复制";
    } catch {
      showResult(`提交成功，访问凭证：${accessToken}`, false);
    }
  });
  actions.append(statusLink, copyButton);
  result.append(message, explanation, actions);
}

function loadTurnstile() {
  const siteKey = String(window.SUBMISSION_SITE_KEY || "").trim();
  if (!siteKey) return;
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.onload = () => {
    window.turnstile?.render("#turnstile-container", {
      sitekey: siteKey,
      callback: (token) => { turnstileToken = token; },
      "expired-callback": () => { turnstileToken = ""; },
      "error-callback": () => { turnstileToken = ""; },
    });
  };
  document.head.append(script);
}

let nameCheckTimer = null;
let nameCheckSeq = 0;
let nameCheckState = { value: "", exists: false, suggestions: [] };

function clearNameHint() {
  clearTimeout(nameCheckTimer);
  nameCheckState = { value: "", exists: false, suggestions: [] };
  if (!nameHint) return;
  nameHint.hidden = true;
  nameHint.className = "name-hint";
  nameHint.replaceChildren();
}

function showNameHint(kind, ...nodes) {
  if (!nameHint) return;
  nameHint.hidden = false;
  nameHint.className = `name-hint ${kind}`.trim();
  nameHint.replaceChildren(...nodes);
}

function renderNameConflict(body, value) {
  const suggestions = Array.isArray(body.suggestions)
    ? body.suggestions.filter((item) => typeof item === "string" && item.trim())
    : [];
  nameCheckState = { value, exists: true, suggestions };
  const existing = body?.conflict?.name;
  const message = document.createElement("span");
  message.textContent = `该名称已存在${existing && existing !== value ? `（现有：${existing}）` : ""}，请换一个名字。`;
  const nodes = [message];
  if (suggestions.length) {
    const label = document.createElement("span");
    label.className = "name-hint-label";
    label.textContent = "建议改名（点击填入）：";
    const group = document.createElement("span");
    group.className = "name-suggestions";
    suggestions.forEach((suggestion) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "name-suggestion";
      chip.textContent = suggestion;
      chip.addEventListener("click", () => {
        nameInput.value = suggestion;
        nameInput.focus();
        scheduleNameCheck();
      });
      group.append(chip);
    });
    nodes.push(label, group);
  }
  showNameHint("conflict", ...nodes);
}

async function runNameCheck(value) {
  const seq = ++nameCheckSeq;
  try {
    const response = await fetch(`/api/name-check?name=${encodeURIComponent(value)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (seq !== nameCheckSeq || nameInput.value.trim() !== value) return;
    if (!response.ok) return;
    if (body.exists) {
      renderNameConflict(body, value);
    } else {
      nameCheckState = { value, exists: false, suggestions: [] };
      const ok = document.createElement("span");
      ok.textContent = "该名称可用 ✓";
      showNameHint("ok", ok);
    }
  } catch {
    if (seq === nameCheckSeq) {
      nameCheckState = { value, exists: false, suggestions: [] };
      nameHint.hidden = true;
    }
  }
}

function scheduleNameCheck() {
  clearTimeout(nameCheckTimer);
  const value = nameInput.value.trim();
  if (!value) { clearNameHint(); return; }
  nameCheckState = { value, exists: false, suggestions: [] };
  const pending = document.createElement("span");
  pending.textContent = "正在检查名称…";
  showNameHint("pending", pending);
  nameCheckTimer = setTimeout(() => { runNameCheck(value); }, 350);
}

if (nameInput && nameHint) {
  nameInput.addEventListener("input", scheduleNameCheck);
  nameInput.addEventListener("blur", () => {
    const value = nameInput.value.trim();
    if (value && value !== nameCheckState.value) {
      clearTimeout(nameCheckTimer);
      runNameCheck(value);
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentName = nameInput.value.trim();
  if (nameCheckState.exists && nameCheckState.value === currentName) {
    const suggestions = (nameCheckState.suggestions || []).join("、");
    const proceed = window.confirm(`名称「${currentName}」已存在，建议改名为${suggestions || "其他名称"}。仍要按当前名称提交吗？`);
    if (!proceed) {
      nameInput.focus();
      return;
    }
  }
  button.disabled = true;
  showResult("正在提交…");
  try {
    const response = await fetch("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(turnstileToken ? { "X-Turnstile-Token": turnstileToken } : {}) },
      body: JSON.stringify({
        name: document.querySelector("#name").value,
        url: document.querySelector("#url").value,
        note: document.querySelector("#note").value,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `提交失败（${response.status}）`);
    localStorage.setItem(`emby-submission-token:${body.submission.id}`, body.accessToken);
    const savedSubmissions = (() => {
      try {
        const values = JSON.parse(localStorage.getItem("emby-submissions") || "[]");
        return Array.isArray(values) ? values : [];
      } catch {
        return [];
      }
    })().filter((item) => item?.id !== body.submission.id);
    savedSubmissions.unshift({ id: body.submission.id, token: body.accessToken });
    localStorage.setItem("emby-submissions", JSON.stringify(savedSubmissions.slice(0, 30)));
    form.reset();
    clearNameHint();
    turnstileToken = "";
    showSubmissionSuccess(body.submission, body.accessToken);
  } catch (error) {
    showResult(error.message, true);
  } finally {
    button.disabled = false;
  }
});

loadTurnstile();
