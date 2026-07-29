const headerActions = document.querySelector(".header-actions");
const importButton = document.querySelector("#import-button");
const proxyButton = document.createElement("button");
proxyButton.className = "button button-secondary";
proxyButton.id = "github-proxy-open-button";
proxyButton.type = "button";
proxyButton.textContent = "GitHub 代理";
headerActions?.insertBefore(proxyButton, importButton || null);

const dialog = document.createElement("dialog");
dialog.className = "github-proxy-dialog";
dialog.id = "github-proxy-dialog";
dialog.innerHTML = `
  <form class="github-proxy-panel" id="github-proxy-form" method="dialog">
    <div class="dialog-heading">
      <h2>GitHub 代理配置</h2>
      <button class="icon-button" id="github-proxy-close-button" type="button" aria-label="关闭" title="关闭">×</button>
    </div>
    <p class="github-proxy-lead">启用后，仅公开配置 <code>/emby-icons.json</code> 中以 <code>https://raw.githubusercontent.com</code> 开头的图标地址会变为“代理 URL/原始图标 URL”。管理面板和网站展示仍使用原始地址。</p>
    <label class="github-proxy-toggle"><input id="github-proxy-enabled" type="checkbox" />启用 GitHub 代理</label>
    <label class="field">
      <span>代理 URL</span>
      <input id="github-proxy-url" type="url" inputmode="url" placeholder="https://your-proxy.example" autocomplete="url" />
    </label>
    <p class="github-proxy-status" id="github-proxy-status" role="status"></p>
    <div class="dialog-actions">
      <button class="button button-secondary" id="github-proxy-cancel-button" type="button">取消</button>
      <button class="button button-primary" id="github-proxy-save-button" type="submit">保存代理配置</button>
    </div>
  </form>`;
document.body.append(dialog);

const form = dialog.querySelector("#github-proxy-form");
const closeButton = dialog.querySelector("#github-proxy-close-button");
const cancelButton = dialog.querySelector("#github-proxy-cancel-button");
const enabledInput = dialog.querySelector("#github-proxy-enabled");
const urlInput = dialog.querySelector("#github-proxy-url");
const saveButton = dialog.querySelector("#github-proxy-save-button");
const status = dialog.querySelector("#github-proxy-status");

function adminHeaders() {
  const token = sessionStorage.getItem("emby-icons-admin-token") || "";
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function setStatus(message, type = "") {
  status.textContent = message;
  status.className = `github-proxy-status${type ? ` is-${type}` : ""}`;
}

async function loadSettings() {
  setStatus("正在加载配置…");
  try {
    const response = await fetch("/api/admin/github-proxy", { headers: adminHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.assign("/admin.html?login=1");
      return;
    }
    if (!response.ok) throw new Error(body.error || `加载配置失败 (${response.status})`);
    enabledInput.checked = body.enabled === true;
    urlInput.value = body.proxyUrl || "";
    setStatus(body.enabled ? "代理已启用" : "代理未启用", body.enabled ? "success" : "");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const proxyUrl = urlInput.value.trim();
  if (enabledInput.checked && !proxyUrl) {
    setStatus("启用代理前请填写代理 URL", "error");
    urlInput.focus();
    return;
  }
  saveButton.disabled = true;
  setStatus("正在保存…");
  try {
    const response = await fetch("/api/admin/github-proxy", {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ enabled: enabledInput.checked, proxyUrl }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.assign("/admin.html?login=1");
      return;
    }
    if (!response.ok) throw new Error(body.error || `保存配置失败 (${response.status})`);
    enabledInput.checked = body.enabled === true;
    urlInput.value = body.proxyUrl || "";
    setStatus(body.enabled ? "代理已启用，公开 JSON 将使用代理地址" : "代理已关闭", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    saveButton.disabled = false;
  }
}

proxyButton.addEventListener("click", () => {
  dialog.showModal();
  loadSettings();
});
closeButton.addEventListener("click", () => dialog.close());
cancelButton.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
form.addEventListener("submit", saveSettings);
