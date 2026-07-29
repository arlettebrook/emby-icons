const searchInput = document.querySelector("#home-search");
const count = document.querySelector("#home-count");
const grid = document.querySelector("#home-grid");
const empty = document.querySelector("#home-empty");
const error = document.querySelector("#home-error");
const updated = document.querySelector("#home-updated");
const total = document.querySelector("#home-total");
const copyLibraryButton = document.querySelector("#copy-library-button");
const metaName = document.querySelector("#home-meta-name");
const metaDescription = document.querySelector("#home-meta-description");
let icons = [];

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function render() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const visible = icons.filter((icon) => `${icon.name} ${icon.url}`.toLocaleLowerCase().includes(query));
  count.textContent = query ? `${visible.length} / ${icons.length} 个图标` : `${icons.length} 个图标`;
  grid.replaceChildren();
  empty.hidden = visible.length > 0;
  visible.forEach((icon) => {
    const url = safeUrl(icon.url);
    if (!url) return;
    const card = document.createElement("article");
    card.className = "icon-card";
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const image = document.createElement("img");
    image.src = url;
    image.alt = icon.name;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    const name = document.createElement("strong");
    name.textContent = icon.name;
    const address = document.createElement("small");
    address.textContent = url;
    link.append(image, name, address);
    card.append(link);
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

searchInput.addEventListener("input", render);
copyLibraryButton.addEventListener("click", async () => {
  const libraryUrl = new URL("/emby-icons.json", window.location.origin).href;
  try {
    await navigator.clipboard.writeText(libraryUrl);
    copyLibraryButton.textContent = "已复制图标库地址";
    window.setTimeout(() => { copyLibraryButton.textContent = "复制图标库地址"; }, 2200);
  } catch {
    window.prompt("请复制图标库地址", libraryUrl);
  }
});
load();
