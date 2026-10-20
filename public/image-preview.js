const NON_IMAGE_EXTENSIONS = new Set([
  ".7z", ".apk", ".avi", ".bin", ".csv", ".dmg", ".doc", ".docx", ".exe",
  ".gz", ".htm", ".html", ".iso", ".json", ".m4a", ".mkv", ".mov", ".mp3",
  ".mp4", ".pdf", ".ppt", ".pptx", ".rar", ".tar", ".txt", ".wav", ".xls",
  ".xlsx", ".xml", ".zip",
]);
const PREVIEW_TIMEOUT_MS = 10000;

function inspectImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { state: "empty" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { state: "invalid", message: "请填写完整的图片地址（以 https:// 开头）。" };
  }
  if (url.protocol !== "https:") return { state: "invalid", message: "图片地址必须使用 HTTPS。" };
  if (url.username || url.password) return { state: "invalid", message: "图片地址不能包含用户名或密码。" };
  const extension = url.pathname.toLowerCase().match(/\.[a-z0-9]{1,10}$/)?.[0] || "";
  if (NON_IMAGE_EXTENSIONS.has(extension)) {
    return {
      state: "error",
      message: "该链接指向 " + extension + " 文件，不是图片。请填写图片直链（PNG、JPG、WebP、GIF 或 SVG）。",
    };
  }
  return { state: "ok", url: url.href };
}

export function imageUrlIssue(value) {
  const inspected = inspectImageUrl(value);
  return inspected.message || "";
}

function stopPreview(container) {
  if (!container) return;
  container.__previewToken = (container.__previewToken || 0) + 1;
  if (container.__previewTimer) {
    clearTimeout(container.__previewTimer);
    container.__previewTimer = 0;
  }
}

function renderMessage(container, message, className) {
  container.hidden = false;
  container.className = "image-preview" + (className ? " " + className : "");
  const text = document.createElement("p");
  text.textContent = message;
  container.replaceChildren(text);
}

export function renderImagePreview(container, value, options = {}) {
  if (!container) return false;
  stopPreview(container);
  const inspected = inspectImageUrl(value);
  if (inspected.state === "empty") {
    container.hidden = true;
    container.replaceChildren();
    return false;
  }
  if (inspected.state !== "ok") {
    renderMessage(container, inspected.message, "is-error");
    return false;
  }

  const token = container.__previewToken;
  container.hidden = false;
  container.className = "image-preview is-loading";
  const image = document.createElement("img");
  image.alt = options.alt || "图标预览";
  image.decoding = "async";
  image.loading = "eager";
  image.referrerPolicy = "no-referrer";
  const text = document.createElement("p");
  text.textContent = "正在加载预览…";
  container.replaceChildren(image, text);

  const fail = () => {
    if (token !== container.__previewToken) return;
    stopPreview(container);
    renderMessage(container, "该链接可能不是图片或不可公开访问", "is-error");
  };
  image.addEventListener("load", () => {
    if (token !== container.__previewToken) return;
    stopPreview(container);
    if (!image.naturalWidth) {
      fail();
      return;
    }
    container.className = "image-preview is-ok";
    text.textContent = "图片可以正常加载。";
  });
  image.addEventListener("error", fail);
  container.__previewTimer = setTimeout(fail, PREVIEW_TIMEOUT_MS);
  image.src = inspected.url;
  return true;
}

export function attachImagePreview(input, container, options = {}) {
  if (!input || !container) return { refresh() {} };
  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = 0;
    return renderImagePreview(container, input.value, options);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, options.debounceMs ?? 350);
  };
  input.addEventListener("input", schedule);
  input.addEventListener("blur", refresh);
  refresh();
  return { refresh };
}
