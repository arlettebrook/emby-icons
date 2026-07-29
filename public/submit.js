const form = document.querySelector("#submission-form");
const button = document.querySelector("#submit-button");
const result = document.querySelector("#result");
let turnstileToken = "";

function showResult(message, error = false) {
  result.hidden = false;
  result.textContent = message;
  result.classList.toggle("error", error);
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
    form.reset();
    turnstileToken = "";
    showResult(`提交成功，编号：${body.submission.id}。请保存此页面或编号，访问令牌已保存在当前浏览器中。`);
  } catch (error) {
    showResult(error.message, true);
  } finally {
    button.disabled = false;
  }
});

loadTurnstile();
