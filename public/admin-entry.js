const loginView = document.querySelector("#admin-login-view");
const app = document.querySelector("#admin-app");
const loginForm = document.querySelector("#admin-login-form");
const tokenInput = document.querySelector("#admin-login-token");
const loginButton = document.querySelector("#admin-login-button");
const loginError = document.querySelector("#admin-login-error");
const params = new URLSearchParams(window.location.search);
const next = params.get("next") || "/admin.html";

function showLogin(message = "") {
  loginView.hidden = false;
  app.hidden = true;
  loginError.textContent = message;
  tokenInput.focus();
}

async function loadAdminApp() {
  loginView.hidden = true;
  app.hidden = false;
  await import("/admin-shell.js");
  await import("/admin-review.js?v=20260729-ui14");
  await import("/admin-proxy.js?v=20260729-ui1");
  await import("/app.js?v=20260731-ui16");
  await import("/admin-validity.js?v=20260731-ui12");
}

async function hasSession() {
  const response = await fetch("/api/admin/session", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  return response.ok && body.ok === true;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;
  loginButton.disabled = true;
  loginError.textContent = "";
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `登录失败（${response.status}）`);
    sessionStorage.setItem("emby-icons-admin-token", token);
    const target = next.startsWith("/admin.html") ? next : "/admin.html";
    if (target === "/admin.html") {
      window.history.replaceState({}, "", "/admin.html");
      await loadAdminApp();
    } else {
      window.location.assign(target);
    }
  } catch (error) {
    loginError.textContent = error.message;
    tokenInput.select();
  } finally {
    loginButton.disabled = false;
  }
});

if (await hasSession()) await loadAdminApp();
else showLogin();
