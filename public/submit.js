const form = document.querySelector("#submission-form");
const button = document.querySelector("#submit-button");
const result = document.querySelector("#result");
const nameInput = document.querySelector("#name");
const nameHint = document.querySelector("#name-hint");
const nameExample = document.querySelector("#name-example");
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
let submitInFlight = false;

function clearNameHint() {
  clearTimeout(nameCheckTimer);
  nameCheckState = { value: "", exists: false, suggestions: [] };
  setNameBlocked(false);
  renderNameExample();
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

function makeSuggestionChips(suggestions) {
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
  return group;
}

function localNameSuggestions(value, count = 2) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return [];
  const match = trimmed.match(/^(.*?)[\s._-]*(\d+)$/u);
  let stem = trimmed;
  let startAt = 2;
  if (match && match[1].trim()) {
    stem = match[1].replace(/[\s._-]+$/u, "").trim();
    startAt = Number(match[2]) + 1;
  }
  const suggestions = [];
  for (let n = Math.max(startAt, 2); n < startAt + 1000 && suggestions.length < count; n += 1) {
    suggestions.push(`${stem}${String(n).padStart(2, "0")}`);
  }
  return suggestions;
}

const NAME_EXAMPLE_HINT = "名称需唯一；重名时会按你输入的名称给出建议。";

function renderNameExample() {
  if (!nameExample) return;
  const value = nameInput ? nameInput.value.trim() : "";
  if (!value) {
    nameExample.replaceChildren(document.createTextNode(NAME_EXAMPLE_HINT));
    return;
  }
  // When the name is taken, the conflict box below already offers the suggestions.
  if (nameCheckState.exists && nameCheckState.value === value) {
    nameExample.replaceChildren();
    return;
  }
  const suggestions = nameCheckState.value === value && nameCheckState.suggestions.length
    ? nameCheckState.suggestions
    : localNameSuggestions(value);
  if (!suggestions.length) {
    nameExample.replaceChildren(document.createTextNode(NAME_EXAMPLE_HINT));
    return;
  }
  const label = document.createElement("span");
  label.textContent = "建议名称（重名时可用）：";
  nameExample.replaceChildren(label, makeSuggestionChips(suggestions));
}

function renderNameConflict(body, value) {
  const suggestions = Array.isArray(body.suggestions)
    ? body.suggestions.filter((item) => typeof item === "string" && item.trim())
    : [];
  nameCheckState = { value, exists: true, suggestions };
  setNameBlocked(true);
  const existing = body?.conflict?.name;
  const message = document.createElement("span");
  message.textContent = `该名称已存在${existing && existing !== value ? `（现有：${existing}）` : ""}，请换一个名字。`;
  const nodes = [message];
  if (suggestions.length) {
    const label = document.createElement("span");
    label.className = "name-hint-label";
    label.textContent = "建议改名（点击填入）：";
    nodes.push(label, makeSuggestionChips(suggestions));
  }
  showNameHint("conflict", ...nodes);
}

function currentNameConflicts() {
  const value = nameInput.value.trim();
  return Boolean(value) && nameCheckState.exists && nameCheckState.value === value;
}

function setNameBlocked(blocked) {
  if (!button) return;
  button.textContent = blocked ? "该名称已存在，请先改名" : "提交审核";
  button.classList.toggle("is-blocked", blocked);
  button.disabled = blocked || submitInFlight;
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
      setNameBlocked(false);
      const ok = document.createElement("span");
      ok.textContent = "该名称可用 ✓";
      showNameHint("ok", ok);
    }
    renderNameExample();
  } catch {
    if (seq === nameCheckSeq) {
      nameCheckState = { value, exists: false, suggestions: [] };
      setNameBlocked(false);
      nameHint.hidden = true;
      renderNameExample();
    }
  }
}

function scheduleNameCheck() {
  clearTimeout(nameCheckTimer);
  const value = nameInput.value.trim();
  if (!value) { clearNameHint(); return; }
  nameCheckState = { value, exists: false, suggestions: [] };
  setNameBlocked(false);
  const pending = document.createElement("span");
  pending.textContent = "正在检查名称…";
  showNameHint("pending", pending);
  renderNameExample();
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
  if (!currentName) {
    showResult("请先填写图标名称。", true);
    nameInput.focus();
    return;
  }
  if (nameCheckState.value !== currentName) await runNameCheck(currentName);
  if (currentNameConflicts()) {
    const suggestions = (nameCheckState.suggestions || []).join("、");
    showResult(`名称「${currentName}」已存在，不能提交，请换一个名字${suggestions ? `（建议：${suggestions}）` : ""}。`, true);
    if (nameHint) nameHint.hidden = false;
    nameInput.focus();
    return;
  }
  submitInFlight = true;
  setNameBlocked(false);
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
    if (!response.ok) {
      if (body.code === "ICON_NAME_CONFLICT") {
        renderNameConflict(body, currentName);
        showResult("该名称已存在，不能提交，请换一个名字。", true);
        return;
      }
      throw new Error(body.error || `提交失败（${response.status}）`);
    }
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
    submitInFlight = false;
    setNameBlocked(currentNameConflicts());
  }
});

if (nameExample) renderNameExample();

loadTurnstile();
