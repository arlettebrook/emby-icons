const form = document.querySelector("#login-form");
const input = document.querySelector("#admin-token");
const button = document.querySelector("#login-button");
const error = document.querySelector("#login-error");
const next = new URLSearchParams(window.location.search).get("next") || "/admin.html";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = input.value.trim();
  if (!token) return;
  button.disabled = true;
  error.textContent = "";
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `登录失败（${response.status}）`);
    sessionStorage.setItem("emby-icons-admin-token", token);
    window.location.assign(next.startsWith("/") ? next : "/admin.html");
  } catch (loginError) {
    error.textContent = loginError.message;
    input.select();
  } finally {
    button.disabled = false;
  }
});
