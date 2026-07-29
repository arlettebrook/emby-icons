const form = document.querySelector("#submission-form");
const button = document.querySelector("#submit-button");
const result = document.querySelector("#result");
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
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
    turnstileToken = "";
    showSubmissionSuccess(body.submission, body.accessToken);
  } catch (error) {
    showResult(error.message, true);
  } finally {
    button.disabled = false;
  }
});

loadTurnstile();
