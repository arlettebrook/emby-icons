const searchInput = document.querySelector("#home-search");
const count = document.querySelector("#home-count");
const grid = document.querySelector("#home-grid");
const empty = document.querySelector("#home-empty");
const error = document.querySelector("#home-error");
const updated = document.querySelector("#home-updated");
const total = document.querySelector("#home-total");
const copyLibraryButton = document.querySelector("#copy-library-button");
const copyLibraryLabel = document.querySelector("#copy-library-label");
const loadMoreButton = document.querySelector("#home-load-more");
const metaName = document.querySelector("#home-meta-name");
const metaDescription = document.querySelector("#home-meta-description");
const PAGE_SIZE = 24;
let icons = [];
let renderLimit = PAGE_SIZE;

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  return new Promise((resolve, reject) => {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
    if (copied) resolve();
    else reject(new Error("复制失败"));
  });
}

function markCopied(button) {
  button.textContent = "✓";
  button.classList.add("is-copied");
  button.title = "已复制图片地址";
  button.setAttribute("aria-label", "已复制图片地址");
  window.setTimeout(() => {
    button.textContent = "⧉";
    button.classList.remove("is-copied");
    button.title = "复制图片地址";
    button.setAttribute("aria-label", "复制图片地址");
  }, 1800);
}

function render() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const matched = icons.filter((icon) => `${icon.name} ${icon.url}`.toLocaleLowerCase().includes(query));
  const visible = matched.slice(0, renderLimit);
  count.textContent = query ? `${matched.length} 个图标，已显示 ${visible.length}` : `${icons.length} 个图标，已显示 ${visible.length}`;
  grid.replaceChildren();
  empty.hidden = matched.length > 0;
  loadMoreButton.hidden = visible.length >= matched.length;
  visible.forEach((icon) => {
    const url = safeUrl(icon.url);
    if (!url) return;
    const card = document.createElement("article");
    card.className = "icon-card";
    const link = document.createElement("a");
    link.className = "icon-preview home-icon-preview";
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.setAttribute("aria-label", `打开${icon.name}图片预览`);
    const image = document.createElement("img");
    image.src = url;
    image.alt = icon.name;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => link.classList.add("has-image"), { once: true });
    image.addEventListener("error", () => link.classList.add("is-broken"), { once: true });
    const name = document.createElement("strong");
    name.textContent = icon.name;
    const address = document.createElement("small");
    address.textContent = url;
    const meta = document.createElement("div");
    meta.className = "home-icon-meta";
    const copyButton = document.createElement("button");
    copyButton.className = "icon-button home-copy-button";
    copyButton.type = "button";
    copyButton.textContent = "⧉";
    copyButton.title = "复制图片地址";
    copyButton.setAttribute("aria-label", "复制图片地址");
    copyButton.addEventListener("click", async () => {
      try {
        await copyText(url);
        markCopied(copyButton);
      } catch {
        window.prompt("请复制图片地址", url);
      }
    });
    link.append(image);
    meta.append(address, copyButton);
    card.append(link, name, meta);
    grid.append(card);
  });
}

async function load() {
  try {
    const response = await fetch("/emby-icons.json", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `加载失败（${response.status}）`);
    if (!Array.isArray(body.icons)) throw new Error("公开图标库格式无效");
    icons = body.icons.filter((icon) => icon && typeof icon.name === "string" && typeof icon.url === "string");
    const documentName = typeof body.name === "string" && body.name.trim() ? body.name : "Emby Icons";
    const documentDescription = typeof body.description === "string" && body.description.trim()
      ? body.description
      : "暂无描述";
    metaName.textContent = documentName;
    metaDescription.textContent = documentDescription;
    total.textContent = String(icons.length);
    updated.textContent = `公开图标库 · ${icons.length} 个图标`;
    render();
  } catch (loadError) {
    count.textContent = "加载失败";
    error.textContent = loadError.message;
    error.hidden = false;
  }
}

searchInput.addEventListener("input", () => {
  renderLimit = PAGE_SIZE;
  render();
});
loadMoreButton.addEventListener("click", () => {
  renderLimit += PAGE_SIZE;
  render();
});
copyLibraryButton.addEventListener("click", async () => {
  const libraryUrl = new URL("/emby-icons.json", window.location.origin).href;
  try {
    await copyText(libraryUrl);
    copyLibraryLabel.textContent = "已复制图标库地址";
    window.setTimeout(() => { copyLibraryLabel.textContent = "复制图标库地址"; }, 2200);
  } catch {
    window.prompt("请复制图标库地址", libraryUrl);
  }
});
load();
