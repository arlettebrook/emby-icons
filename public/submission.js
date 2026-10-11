const list = document.querySelector("#submission-list");
const empty = document.querySelector("#submission-empty");
const detail = document.querySelector("#submission-detail");
const info = document.querySelector("#submission-info");
const countWrap = document.querySelector("#submission-count");
const countValue = document.querySelector("#submission-count-value");
const editForm = document.querySelector("#edit-form");
const nameInput = document.querySelector("#edit-name");
const urlInput = document.querySelector("#edit-url");
const noteInput = document.querySelector("#edit-note");
const saveButton = document.querySelector("#save-button");
const withdrawButton = document.querySelector("#withdraw-button");
const withdrawCancel = document.querySelector("#withdraw-cancel");
const deleteButton = document.querySelector("#delete-button");
const deleteCancel = document.querySelector("#delete-cancel");
const recordActions = document.querySelector("#record-actions");
const resubmitHint = document.querySelector("#resubmit-hint");
const result = document.querySelector("#result");
const detailResult = document.querySelector("#detail-result");
const clearAllWrap = document.querySelector("#submission-clear");
const clearAllButton = document.querySelector("#clear-all-button");
const clearAllCancel = document.querySelector("#clear-all-cancel");
const detailClip = document.querySelector("#detail-clip");
const detailTurnstile = document.querySelector("#detail-turnstile");
const turnstileContainer = document.querySelector("#turnstile-container");
const turnstileError = document.querySelector("#turnstile-error");
const queryId = new URLSearchParams(window.location.search).get("id");
let currentId = "";
let currentToken = "";
let currentStatus = "";
let knownReferences = [];
// 列表项的本地缓存：保存/撤回/删除后直接改这里，不再整表重新拉取。
let currentItems = [];
let currentSubmission = null;
// 详情块的渲染签名：同一份数据不重复重建（URL 可能是几十 KB 的 data: 串）。
let detailSignature = "";
const TURNSTILE_SITE_KEY = String(window.SUBMISSION_SITE_KEY || "").trim();
let turnstileToken = "";
let turnstileWidgetId = null;
let turnstileScriptState = "idle";
let turnstileFailed = false;
let detailAnimation = null;

const STATUS_META = {
  pending: { label: "待审核", className: "pending" },
  approving: { label: "发布中", className: "approving" },
  approved: { label: "已发布", className: "approved" },
  rejected: { label: "已拒绝", className: "rejected" },
  withdrawn: { label: "已撤回", className: "withdrawn" },
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status || "未知", className: "" };
}

function tokenStorageKey(id) {
  return "emby-submission-token:" + id;
}

function readSavedSubmissions() {
  try {
    const values = JSON.parse(localStorage.getItem("emby-submissions") || "[]");
    const saved = Array.isArray(values) ? values.filter((item) => item?.id && item?.token) : [];
    const known = new Set(saved.map((item) => item.id));
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      if (!key.startsWith("emby-submission-token:")) continue;
      const id = key.slice("emby-submission-token:".length);
      const token = localStorage.getItem(key) || "";
      if (id && token && !known.has(id)) saved.push({ id, token });
    }
    return saved;
  } catch {
    return [];
  }
}

// 把当前列表的引用整体写回本地。以前是每加载一条记录就同步写一次 localStorage，
// 30 条记录会在主线程上写 30 次，首屏明显被拖慢；现在每次加载最多写一次，
// 内容没变化时直接跳过。
function persistReferences(items) {
  const wanted = new Map();
  for (const item of items.slice(0, 30)) {
    // 列表项是 { submission, token }，本地引用是 { id, token }，两种形状都认。
    const id = (item.submission && item.submission.id) || item.id;
    if (!id || !item.token) continue;
    wanted.set(id, item.token);
  }
  // 一条有效引用都提取不到时什么都不写：宁可保持原状，也不能把已有记录覆盖掉。
  if (!wanted.size) return;
  const current = readSavedSubmissions();
  const unchanged = current.length === wanted.size && current.every((item) => wanted.get(item.id) === item.token);
  if (unchanged) return;
  try {
    localStorage.setItem("emby-submissions", JSON.stringify(Array.from(wanted, ([id, token]) => ({ id, token }))));
    wanted.forEach((token, id) => localStorage.setItem(tokenStorageKey(id), token));
  } catch {
    // 浏览器存储不可用时忽略；刷新后会以服务端结果为准。
  }
}

// 删除本地记录：列表条目和单独的 token 键都要清掉，否则下次加载会出现幽灵条目。
function removeSavedSubmission(id) {
  try {
    localStorage.setItem("emby-submissions", JSON.stringify(readSavedSubmissions().filter((item) => item.id !== id)));
    localStorage.removeItem(tokenStorageKey(id));
  } catch {
    // 浏览器存储不可用时忽略；刷新后会以服务端结果为准。
  }
}

function applyBadge(element, status) {
  const meta = statusMeta(status);
  element.textContent = meta.label;
  element.className = meta.className ? "status-badge " + meta.className : "status-badge";
}

// 提示条只在真的跑出视口时才补一次最小滚动。以前每次都用 smooth 滚动，
// 会和展开动画抢合成线程，长列表里保存一次就掉一帧。
function showResult(message, error = false, target = result) {
  target.hidden = false;
  target.textContent = message;
  target.classList.toggle("error", error);
  const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!viewport) return;
  const rect = target.getBoundingClientRect();
  if (rect.top >= 0 && rect.bottom <= viewport) return;
  const offset = rect.top < 0 ? rect.top - 24 : rect.bottom - viewport + 24;
  window.scrollTo({ top: Math.max(window.scrollY + offset, 0), behavior: "auto" });
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "—") : date.toLocaleString();
}

// 缩略图加载失败时用占位方块兜底，避免列表里留下破图。
function iconThumb(url) {
  const img = document.createElement("img");
  img.className = "card-thumb";
  img.alt = "";
  img.decoding = "async";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => {
    const fallback = document.createElement("span");
    fallback.className = "card-thumb-fallback";
    fallback.textContent = "?";
    fallback.setAttribute("aria-hidden", "true");
    img.replaceWith(fallback);
  });
  // 复用卡片节点时先不设 src：空串会被解析成当前页面地址并触发 error 兜底。
  if (url) img.src = url;
  return img;
}

// ---------- Cloudflare Turnstile：重新提交和 /submit.html 走同一套校验 ----------
function turnstileEnabled() {
  return Boolean(TURNSTILE_SITE_KEY);
}

function setTurnstileError(message) {
  if (!turnstileError) return;
  turnstileError.textContent = message || "";
  turnstileError.hidden = !message;
}

function loadTurnstileScript() {
  if (!turnstileEnabled() || turnstileScriptState !== "idle") return;
  turnstileScriptState = "loading";
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.onload = () => {
    turnstileScriptState = window.turnstile ? "ready" : "failed";
    if (turnstileScriptState === "failed") setTurnstileError("人机验证加载失败，请刷新页面后重试。");
    mountTurnstile();
  };
  script.onerror = () => {
    turnstileScriptState = "failed";
    setTurnstileError("人机验证加载失败，请检查网络后重试。");
  };
  document.head.append(script);
}

// 控件只在需要时挂载，且必须等容器可见，否则 Turnstile 量不到尺寸。
function mountTurnstile() {
  if (!turnstileEnabled() || turnstileScriptState !== "ready" || turnstileWidgetId !== null) return;
  if (!turnstileContainer || detailTurnstile?.hidden) return;
  try {
    turnstileWidgetId = window.turnstile.render(turnstileContainer, {
      sitekey: TURNSTILE_SITE_KEY,
      // 令牌 300 秒后过期，允许控件在过期时自动重新签发。
      "refresh-expired": "auto",
      callback: (token) => {
        turnstileToken = token;
        turnstileFailed = false;
        setTurnstileError("");
      },
      "expired-callback": () => {
        turnstileToken = "";
      },
      "error-callback": () => {
        // 页面环境（例如部分 WebView）拿不到验证令牌时不要卡死：放行给服务端判定。
        turnstileToken = "";
        turnstileFailed = true;
        setTurnstileError("人机验证未能完成，可再试一次；若一直失败，请换浏览器或稍后再提交。");
      },
    });
  } catch {
    turnstileFailed = true;
    setTurnstileError("人机验证初始化失败，请刷新页面后重试。");
  }
}

// 令牌是一次性的：每次重新提交（无论成功还是失败）后都要重置控件，
// 否则控件会停在旧结果上、不再签发新令牌，导致下一次提交验证失效。
function resetTurnstile() {
  turnstileToken = "";
  setTurnstileError("");
  try {
    if (window.turnstile && turnstileWidgetId !== null && turnstileWidgetId !== undefined) {
      window.turnstile.reset(turnstileWidgetId);
    }
  } catch {
    // 忽略：下一次重新提交时要求访客重新完成验证即可。
  }
}

function markActiveCard(id) {
  for (const card of list.children) {
    if (!card.classList.contains("submission-card")) continue;
    const active = card.dataset.id === id;
    // 状态没变就别碰 DOM：反复写属性会让长列表每选中一次都重排。
    if ((card.dataset.active === "true") === active) continue;
    card.dataset.active = active ? "true" : "false";
    card.setAttribute("aria-expanded", active ? "true" : "false");
    if (active) card.setAttribute("aria-current", "true");
    else card.removeAttribute("aria-current");
  }
}

function metaRow(label, value, options) {
  const settings = options || {};
  const row = document.createElement("div");
  row.className = settings.span ? "meta-row span-2" : "meta-row";
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (settings.node) dd.append(settings.node);
  else dd.textContent = value;
  row.append(dt, dd);
  return row;
}

const URL_PREVIEW_LIMIT = 72;

// 图标 URL 常常是几十 KB 的 data: 串。整串塞进文本节点后，换行排版（break-all）
// 要处理上万个行盒，展开/收起动画每帧都得重排，是这一页最明显的卡顿来源。
// 这里只显示开头一段，完整值仍由「复制」按钮提供。
function urlPreview(url) {
  const text = String(url || "");
  if (text.length <= URL_PREVIEW_LIMIT) return text;
  return text.slice(0, URL_PREVIEW_LIMIT) + "…（共 " + text.length.toLocaleString("zh-CN") + " 字符）";
}

function buildUrlValue(url) {
  const wrap = document.createElement("span");
  wrap.className = "meta-inline";
  const link = document.createElement("a");
  link.className = "meta-link";
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.title = "打开图标链接";
  link.textContent = urlPreview(url);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.textContent = "复制";
  copy.addEventListener("click", () => copyText(url, copy));
  wrap.append(link, copy);
  return wrap;
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

async function copyText(text, button) {
  const original = button.textContent;
  button.textContent = "复制中…";
  let ok = false;
  // 部分 WebView 里 clipboard 写入会一直悬着，这里加超时兜底，保证按钮一定有反馈。
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      ok = await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise((resolve) => window.setTimeout(() => resolve(false), 700)),
      ]);
    } catch {
      ok = false;
    }
  }
  if (!ok) ok = fallbackCopy(text);
  button.textContent = ok ? "已复制" : "复制失败";
  window.setTimeout(() => {
    button.textContent = original;
  }, 1600);
}

function renderMeta(submission) {
  info.replaceChildren(
    metaRow("状态", statusMeta(submission.status).label),
    metaRow("提交时间", formatTime(submission.created_at)),
    metaRow("名称", submission.name, { span: true }),
    metaRow("编号", submission.id, { span: true }),
    metaRow("图标 URL", "", { span: true, node: buildUrlValue(submission.url) }),
  );
  if (submission.reviewer_note) {
    info.append(
      metaRow(submission.status === "rejected" ? "拒绝原因" : "审核备注", submission.reviewer_note, { span: true }),
    );
  }
}

function renderSubmissionInfo(submission) {
  // 换到另一条记录时，之前的「待确认」按钮不应该还亮着。
  resetConfirmFlows();
  currentStatus = submission.status;
  // 同一份数据重复渲染（保存后刷新、重新选中同一条）时不再重建详情块：
  // 元信息里的 URL 可能是几十 KB 的 data: 串，重建会让面板掉帧。
  // 用不会出现在字段里的控制字符拼接，避免名称/链接内容互相干扰。
  const signature = [
    submission.id,
    submission.name,
    submission.status,
    submission.url,
    submission.note || "",
    submission.created_at || "",
    submission.reviewer_note || "",
  ].join("\u0001");
  if (signature !== detailSignature) {
    detailSignature = signature;
    renderMeta(submission);
  }

  // 待审核可以改；被拒绝/已撤回可以改好后重新提交，所以编辑表单也要露出来。
  const editable = submission.status === "pending";
  const resubmittable = submission.status === "rejected" || submission.status === "withdrawn";
  const formVisible = editable || resubmittable;
  editForm.hidden = !formVisible;
  saveButton.textContent = editable ? "保存修改" : "重新提交审核";
  withdrawButton.hidden = !editable;
  resubmitHint.hidden = !resubmittable;
  // 重新提交要在服务端过 Cloudflare Turnstile，和 /submit.html 保持一致；
  // 只有被拒绝/已撤回的记录会走到这里，待审核的「保存修改」不需要验证。
  const needsTurnstile = resubmittable && turnstileEnabled();
  detailTurnstile.hidden = !needsTurnstile;
  if (needsTurnstile) {
    // 换一条记录就换一份令牌：Turnstile 的令牌是一次性的。
    resetTurnstile();
    loadTurnstileScript();
    mountTurnstile();
  } else {
    turnstileToken = "";
    turnstileFailed = false;
    setTurnstileError("");
  }
  // 发布中不允许删除（服务端会拒绝），这里也把入口收起来，避免点了才报错。
  recordActions.hidden = submission.status === "approving";
  if (formVisible) {
    // 只在值真的变了才写回：URL 可能是几十 KB 的 data: 串，反复赋值会重新排版。
    const note = submission.note || "";
    if (nameInput.value !== submission.name) nameInput.value = submission.name;
    if (urlInput.value !== submission.url) urlInput.value = submission.url;
    if (noteInput.value !== note) noteInput.value = note;
  }
  detail.hidden = false;
}

// 卡片只创建一次，之后按 id 复用、只更新变化的文案。
// 以前每次刷新都重建整张卡片，缩略图（data: 串）会被重新解码，长列表里很卡。
function buildCard() {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "submission-card";
  card.dataset.active = "false";
  card.setAttribute("aria-expanded", "false");

  const main = document.createElement("span");
  main.className = "card-main";
  const title = document.createElement("span");
  title.className = "card-title";
  const sub = document.createElement("span");
  sub.className = "card-sub";
  const badge = document.createElement("span");
  const idText = document.createElement("span");
  idText.className = "card-id";
  sub.append(badge, idText);
  main.append(title, sub);

  const chevron = document.createElement("span");
  chevron.className = "card-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "›";

  const thumb = iconThumb("");
  card.append(thumb, main, chevron);
  card.__thumb = thumb;
  card.__title = title;
  card.__badge = badge;
  card.__idText = idText;
  card.addEventListener("click", () => {
    const item = card.__item;
    if (!item) return;
    // 再点一次当前记录就收起详情，避免只能靠滚到页面底部操作。
    if (currentId === item.submission.id && !detail.hidden) {
      // 收起动画进行中不重复触发，否则要等两次动画跑完才关掉。
      if (!detailClosing) resetDetailPanel({ animate: true });
      return;
    }
    selectSubmission(item.submission.id, item.token, item.submission);
  });
  return card;
}

function updateCard(card, item) {
  const { submission } = item;
  card.__item = item;
  card.dataset.id = submission.id;
  card.setAttribute(
    "aria-label",
    submission.name + "，状态：" + statusMeta(submission.status).label + "，查看详情",
  );
  card.__title.textContent = submission.name;
  card.__idText.textContent = "#" + String(submission.id).slice(0, 8);
  applyBadge(card.__badge, submission.status);
  if (card.__thumbUrl !== submission.url) {
    card.__thumbUrl = submission.url;
    const next = iconThumb(submission.url);
    card.__thumb.replaceWith(next);
    card.__thumb = next;
  }
  return card;
}

// 按 id 查卡片：比 querySelector 拼字符串更稳（id 来自本地存储，可能带特殊字符）。
function findCard(id) {
  for (const node of list.children) {
    if (node.classList.contains("submission-card") && node.dataset.id === id) return node;
  }
  return null;
}

function renderList(items) {
  // 详情面板现在住在列表里，重排前先摘下来，否则会被当成列表项处理。
  detail.remove();
  const reuse = new Map();
  for (const node of list.children) {
    if (node.classList.contains("submission-card")) reuse.set(node.dataset.id, node);
  }
  const hasItems = items.length > 0;
  countValue.textContent = String(items.length);
  countWrap.hidden = !hasItems;
  clearAllWrap.hidden = !hasItems;
  empty.hidden = hasItems;
  items.forEach((item, index) => {
    const card = reuse.get(item.submission.id) || buildCard();
    reuse.delete(item.submission.id);
    updateCard(card, item);
    // 位置没变就不动 DOM：整表 insertBefore 等于零成本，只有真换顺序才重排。
    const at = list.children[index];
    if (at !== card) list.insertBefore(card, at || null);
  });
  // 剩下的都是已经被删掉的记录。
  reuse.forEach((node) => node.remove());
}

// ---------- 展开/收起动画 ----------
const DETAIL_ANIM_MS = 240;
const DETAIL_CLOSE_MS = DETAIL_ANIM_MS - 60;
let detailCloseTimer = 0;
let detailClosing = false;

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function canAnimateDetail() {
  return Boolean(detailClip) && typeof detailClip.animate === "function" && !prefersReducedMotion();
}

// 立刻停掉进行中的展开/收起：换记录时先归位，量到的才是自然高度。
function stopDetailAnimation() {
  if (detailCloseTimer) {
    window.clearTimeout(detailCloseTimer);
    detailCloseTimer = 0;
  }
  detailClosing = false;
  if (detailAnimation) {
    try {
      detailAnimation.cancel();
    } catch {
      // 忽略：动画可能已经自己结束。
    }
    detailAnimation = null;
  }
}

// 展开：高度从 0 撑开 + 轻微上移淡入，让「在记录下方就地展开」有个可感知的过程。
function playDetailOpen() {
  if (!canAnimateDetail()) return;
  const height = detailClip.scrollHeight;
  if (!height) return;
  stopDetailAnimation();
  detailAnimation = detailClip.animate(
    [
      { height: "0px", opacity: 0, transform: "translateY(-6px)" },
      { height: height + "px", opacity: 1, transform: "translateY(0)" },
    ],
    { duration: DETAIL_ANIM_MS, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" },
  );
  // fill 保持默认的 none：动画结束后高度自动回到 CSS 的 auto，
  // 之后再出现提示文案（例如保存结果）也不会被裁掉。
  detailAnimation.finished.catch(() => {});
}

// 收起：先把高度收回 0 再真正隐藏，避免面板突然消失；被取消时（例如马上点了别的记录）不再收回。
function playDetailClose(done) {
  if (!canAnimateDetail()) {
    done();
    return;
  }
  const height = detailClip.scrollHeight;
  if (!height) {
    done();
    return;
  }
  stopDetailAnimation();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (detailCloseTimer) {
      window.clearTimeout(detailCloseTimer);
      detailCloseTimer = 0;
    }
    detailAnimation = null;
    detailClosing = false;
    done();
  };
  const animation = detailClip.animate(
    [
      { height: height + "px", opacity: 1 },
      { height: "0px", opacity: 0 },
    ],
    { duration: DETAIL_CLOSE_MS, easing: "ease-in" },
  );
  detailAnimation = animation;
  detailClosing = true;
  // 后台标签页、无头浏览器里 finished 可能迟迟不 resolve，这里用定时器兜底，
  // 保证面板一定会被收起，不会卡在「半开着」的状态。
  detailCloseTimer = window.setTimeout(settle, DETAIL_CLOSE_MS + 90);
  animation.finished.then(settle).catch(() => {});
}

// 展开后如果面板底部被视口截断，就向上滚「刚好够用」的距离；已经完全可见时不动页面，
// 避免「每次点开都跳到最下面」，也避免长面板把所属卡片推出屏幕。
function revealDetail(activeCard) {
  if (!activeCard) return;
  const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!viewport) return;
  const margin = 16;
  const rect = detail.getBoundingClientRect();
  const overflow = rect.bottom - (viewport - margin);
  if (overflow <= 0) return;
  const limit = Math.max(window.scrollY + rect.top - margin, 0);
  const target = Math.min(window.scrollY + overflow, limit);
  if (Math.abs(target - window.scrollY) < 4) return;
  window.scrollTo({ top: target, behavior: "smooth" });
}

function selectSubmission(id, token, submission, options) {
  const settings = options || {};
  currentId = id;
  currentToken = token;
  currentSubmission = submission;
  renderSubmissionInfo(submission);
  markActiveCard(id);
  // 详情面板紧跟被点开的卡片，形成「在记录下面就地展开」的效果。
  const activeCard = findCard(id);
  if (activeCard) activeCard.after(detail);
  else list.append(detail);
  // 先停掉上一条记录残留的动画，否则下面量到的是动画中间的高度。
  stopDetailAnimation();
  // 先按完整高度决定要不要滚动，再播展开动画，否则动画期间的 0 高度会让判断失真。
  if (settings.scroll !== false) revealDetail(activeCard);
  if (settings.animate === false) return;
  playDetailOpen();
}

async function loadOne(reference) {
  let status = 0;
  try {
    const response = await fetch("/api/submissions/" + encodeURIComponent(reference.id), {
      headers: { "X-Submission-Token": reference.token },
      cache: "no-store",
    });
    status = response.status;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "查询失败（" + response.status + "）");
    return { submission: body.submission, token: reference.token };
  } catch (error) {
    // 404 说明记录已经不存在（例如在别处删除了），可以安全地清掉本地引用。
    return { error: error.message, missing: status === 404, id: reference.id };
  }
}

// 清掉当前选中态（高亮、待确认按钮、当前记录信息）。
function clearDetailSelection() {
  resetConfirmFlows();
  currentId = "";
  currentToken = "";
  currentStatus = "";
  markActiveCard("");
}

// 真正隐藏面板本体（收拢动画结束后才调用）。
function hideDetailPanel() {
  detailClosing = false;
  // 面板收起来就清掉缓存签名，下次展开同一条记录时会正常重建详情块。
  detailSignature = "";
  detail.hidden = true;
  editForm.hidden = true;
  recordActions.hidden = true;
  detailResult.hidden = true;
}

function resetDetailPanel(options) {
  const animate = options?.animate === true && !detail.hidden && !detailClosing;
  if (animate) {
    // 收起动画期间先留着卡片高亮，等面板真正收完再清掉，收起过程更连贯。
    playDetailClose(() => {
      clearDetailSelection();
      hideDetailPanel();
    });
    return;
  }
  stopDetailAnimation();
  clearDetailSelection();
  hideDetailPanel();
}

async function loadAll() {
  const references = readSavedSubmissions();
  knownReferences = references;
  if (!references.length) {
    currentItems = [];
    renderList([]);
    resetDetailPanel();
    countWrap.hidden = true;
    clearAllWrap.hidden = true;
    empty.hidden = false;
    return;
  }
  const loaded = await Promise.all(references.map(loadOne));
  // 服务端已经不存在的记录直接从本地清掉，避免列表里留下点不开的幽灵条目。
  loaded.filter((item) => item.missing).forEach((item) => removeSavedSubmission(item.id));
  // 服务端返回顺序不稳定，按提交时间倒序排列，保证每次打开顺序一致（新的在上面）。
  const submittedAt = (item) => Date.parse(item.submission.created_at || "") || 0;
  const valid = loaded
    .filter((item) => item.submission)
    .sort((a, b) => submittedAt(b) - submittedAt(a));
  currentItems = valid;
  renderList(valid);
  // 本地引用一次性写回，避免每条记录都同步写一次 localStorage。
  persistReferences(valid.map((item) => ({ id: item.submission.id, token: item.token })));
  // 保存/撤回/重新提交后仍然停留在同一条记录上，只有它消失时才回退到首条。
  const selected =
    valid.find((item) => item.submission.id === currentId) ||
    valid.find((item) => item.submission.id === queryId) ||
    valid[0];
  // 列表刷新触发的选中不播展开动画，避免每次保存/删除后整页「呼吸」一下。
  if (selected) selectSubmission(selected.submission.id, selected.token, selected.submission, { scroll: false, animate: false });
  else resetDetailPanel();
  const failed = loaded.find((item) => item.error);
  if (failed && !valid.length) showResult("暂时无法读取保存的提交记录，请重新提交或检查浏览器存储。", true);
}

// 局部刷新：保存、撤回、删除后不再整表重新拉取，直接改本地缓存再重排列表，
// 省掉一轮全量请求和整表 DOM 重建。
function replaceItem(submission) {
  const index = currentItems.findIndex((item) => item.submission.id === submission.id);
  if (index < 0) {
    loadAll();
    return;
  }
  const next = currentItems.slice();
  next[index] = { submission, token: currentItems[index].token };
  currentItems = next;
  renderList(currentItems);
  syncSelection(submission.id);
}

// 删除本地已不存在的记录：列表里少一条，选中态回退到第一条。
function dropItem(id) {
  currentItems = currentItems.filter((item) => item.submission.id !== id);
  knownReferences = knownReferences.filter((item) => item.id !== id);
  renderList(currentItems);
  syncSelection("");
}

// 列表重排后把详情面板接回当前记录；记录没了就回退到第一条。
function syncSelection(preferredId) {
  const wanted = preferredId || currentId;
  const selected = currentItems.find((item) => item.submission.id === wanted) || currentItems[0];
  if (!selected) {
    resetDetailPanel();
    return;
  }
  // 局部刷新不播动画、也不滚动页面，避免保存后整页「呼吸」一下。
  selectSubmission(selected.submission.id, selected.token, selected.submission, { scroll: false, animate: false });
}

// 统一的按钮忙碌态：禁用 + 换文案 + 转圈，结束后恢复（或按当前状态重算文案）。
async function runAction(button, busyLabel, action, finalLabel) {
  if (button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.dataset.busy = "true";
  button.textContent = busyLabel;
  try {
    await action();
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
    button.textContent = typeof finalLabel === "function" ? finalLabel() : original;
  }
}

async function saveSubmission(event) {
  event.preventDefault();
  const resubmitting = currentStatus !== "pending";
  const payload = {
    name: nameInput.value,
    url: urlInput.value,
    note: noteInput.value,
  };
  // 非待审核的记录走「重新提交」：服务端会把它改回待审核队列并重新通知审核人。
  if (resubmitting) payload.resubmit = true;
  // 重新提交和 /submit.html 一样要过 Cloudflare 人机验证；
  // 控件没渲染出来（脚本被拦等）时不拦本地提交，交给服务端判定。
  const verifying = resubmitting && turnstileEnabled() && turnstileWidgetId !== null;
  if (verifying && !turnstileFailed && !turnstileToken) {
    showResult("请先完成上方的人机验证，再点「重新提交审核」。", true, detailResult);
    detailTurnstile.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const busyLabel = resubmitting ? "重新提交中…" : "保存中…";
  await runAction(
    saveButton,
    busyLabel,
    async () => {
      withdrawButton.disabled = true;
      try {
        const response = await fetch("/api/submissions/" + encodeURIComponent(currentId), {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Submission-Token": currentToken,
            ...(verifying && turnstileToken ? { "X-Turnstile-Token": turnstileToken } : {}),
          },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (/turnstile/i.test(String(body.error || ""))) {
            // 令牌过期或已被用过：刷新控件，让访客重新完成验证再提交。
            resetTurnstile();
            // 控件压根没挂上（脚本被拦、WebView 不支持）时给出能照做的提示，避免反复重试。
            const hint =
              turnstileWidgetId === null
                ? "人机验证未加载成功，请刷新页面后重试，或换用浏览器打开。"
                : "Cloudflare 人机验证已失效，已刷新验证，请重新完成后再次提交。";
            showResult(hint, true, detailResult);
            return;
          }
          throw new Error(body.error || "保存失败（" + response.status + "）");
        }
        showResult(body.resubmitted ? "已重新提交，等待审核。" : "修改已保存。", false, detailResult);
        // 服务端响应里已经带着最新记录，直接就地更新，省掉一轮全量请求和整表重建。
        if (body.submission) replaceItem(body.submission);
        else await loadAll();
      } catch (error) {
        showResult(error.message, true, detailResult);
      } finally {
        withdrawButton.disabled = false;
        // 令牌一次性：无论成功失败都重置控件，下次提交需要重新验证。
        if (verifying) resetTurnstile();
      }
    },
    () => (currentStatus === "pending" ? "保存修改" : "重新提交审核"),
  );
}

async function withdrawSubmission() {
  // 请求期间访客可能点了别的记录，先把目标固定下来。
  const id = currentId;
  const token = currentToken;
  const base = currentSubmission;
  await runAction(withdrawButton, "撤回中…", async () => {
    try {
      const response = await fetch("/api/submissions/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "X-Submission-Token": token },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "撤回失败（" + response.status + "）");
      showResult("提交已撤回，可修改后重新提交。", false, detailResult);
      // 撤回只改状态（接口不返回整条记录），本地同步一份即可。
      if (base) replaceItem({ ...base, id, status: "withdrawn" });
      else await loadAll();
    } catch (error) {
      showResult(error.message, true, detailResult);
    }
  });
}

async function deleteSubmission() {
  if (!currentId) return;
  const id = currentId;
  const token = currentToken;
  await runAction(deleteButton, "删除中…", async () => {
    try {
      const response = await fetch("/api/submissions/" + encodeURIComponent(id), {
        method: "DELETE",
        headers: { "X-Submission-Token": token },
      });
      // 记录已不存在（404）同样按删除成功处理，否则本地残留永远清不掉。
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "删除失败（" + response.status + "）");
      }
      removeSavedSubmission(id);
      resetDetailPanel();
      // 删除后面板会关闭，所以结果提示放到列表上方。
      showResult("提交记录已删除。", false, result);
      // 只从本地列表里摘掉这一条，其它卡片和缩略图都不重建。
      if (currentItems.some((item) => item.submission.id === id)) dropItem(id);
      else await loadAll();
    } catch (error) {
      showResult(error.message, true, detailResult);
    }
  });
}

// 一键清空全部本地记录：逐条调用删除接口，发布中的记录服务端会拒绝，失败的最后统一提示。
async function clearAllSubmissions() {
  const references = knownReferences.slice();
  if (!references.length) {
    showResult("当前没有可清除的记录。", true, result);
    return;
  }
  await runAction(clearAllButton, "清除中…", async () => {
    let removed = 0;
    let failed = 0;
    for (const reference of references) {
      try {
        const response = await fetch("/api/submissions/" + encodeURIComponent(reference.id), {
          method: "DELETE",
          headers: { "X-Submission-Token": reference.token },
        });
        // 记录本来就不存在（404）也算清除成功。
        if (!response.ok && response.status !== 404) throw new Error("删除失败（" + response.status + "）");
        removeSavedSubmission(reference.id);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    await loadAll();
    if (failed) {
      showResult("已清除 " + removed + " 条记录，" + failed + " 条未能删除（发布中的提交不可删除），可稍后重试。", true, result);
    } else {
      showResult("已清除全部 " + removed + " 条记录。", false, result);
    }
  });
}

// 作为 Telegram Mini App 打开时，通知 Telegram 页面已就绪并铺满可视区域；
// 在普通浏览器中 window.Telegram 不存在，直接跳过。
function initTelegramWebApp() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    document.documentElement.classList.add("telegram-webapp");
  } catch {
    // 旧版本 SDK 或非 Telegram 环境：忽略即可。
  }
}

// 两步确认：原生 confirm 弹窗在 Telegram Mini App 里很突兀，这里改成
// 「第一次点击进入待确认态 → 再点一次执行 / 点取消或 8 秒后自动还原」，降低误触。
const confirmFlows = [];

function resetConfirmFlows() {
  confirmFlows.forEach((flow) => flow.reset());
}

function createConfirmFlow(button, cancelButton, options) {
  const settings = options || {};
  let timer = 0;
  const api = {
    reset() {
      window.clearTimeout(timer);
      timer = 0;
      button.dataset.confirm = "false";
      button.textContent = settings.label;
      cancelButton.hidden = true;
    },
  };
  const arm = () => {
    confirmFlows.forEach((flow) => {
      if (flow !== api) flow.reset();
    });
    button.dataset.confirm = "true";
    button.textContent = settings.confirmLabel;
    cancelButton.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(api.reset, 8000);
  };
  cancelButton.addEventListener("click", api.reset);
  button.addEventListener("click", async () => {
    if (button.dataset.confirm !== "true") {
      arm();
      return;
    }
    api.reset();
    await settings.action();
  });
  api.reset();
  confirmFlows.push(api);
  return api;
}

// 表单控件都是首次渲染就存在，这里直接绑定，避免依赖渲染顺序。
createConfirmFlow(clearAllButton, clearAllCancel, {
  label: "清空全部记录",
  confirmLabel: "确认清空全部",
  action: clearAllSubmissions,
});
createConfirmFlow(withdrawButton, withdrawCancel, {
  label: "撤回提交",
  confirmLabel: "确认撤回",
  action: withdrawSubmission,
});
createConfirmFlow(deleteButton, deleteCancel, {
  label: "删除记录",
  confirmLabel: "确认删除",
  action: deleteSubmission,
});

editForm.addEventListener("submit", saveSubmission);
loadAll();
initTelegramWebApp();
