import assert from "node:assert/strict";
import test from "node:test";

import * as telegramAdminRoute from "../functions/api/admin/telegram.js";
import {
  handleAdminTelegramSettings,
  handleTelegramWebhook,
  notifyNewSubmission,
  notifySubmissionResult,
  verifyTelegramInitData,
} from "../functions/_shared/telegram.js";
import {
  handleMySubmissionList,
  handleSubmissionCreate,
  handleSubmissionItem,
} from "../functions/_shared/submissions.js";
import {
  adminHeaders,
  createEnvironment,
  createSubmission,
  decide,
  makeTelegramInitData,
  readKv,
} from "./helpers.js";

const CHAT_ID = "7328767184";
const USER_ID = "1001";
const BOT_TOKEN = "123456:TEST-TOKEN";
const ANNOUNCEMENT_EMBED_URL = "https://t.me/MikuNaNChannel/8?embed=1&mode=tme";
const ANNOUNCEMENT_EMBED_HTML = [
  "<!doctype html><html><body>",
  '<div class="tgme_widget_message_text js-message_text" dir="auto">',
  '<i class="emoji"><b>🖼</b></i> Emby 自用图标库<br/><br/>',
  "目前「2025.7.31」已收录 2500+ Emby 图标。<br/><br/>",
  "自带GitHub代理加速。<br/><br/>",
  "自带清理无效图标。<br/><br/>",
  "导入地址： <code>https://emby-icons.lyra.cc.cd/emby-icons.json</code><br/><br/>",
  "备用地址： <code>https://lyra.bbroot.com/emby-icons.json</code><br/><br/>",
  '<a href="http://t.me/emby_icons_bot/submit" onclick="alert(1)">新增图标</a><br/><br/>',
  '<a href="https://github.com/arlettebrook/emby-icons"><tg-spoiler><u>备用新增图标</u></tg-spoiler></a><br/><br/>',
  "# <i>图标来自各位大佬，如不希望收录请 </i>",
  '<a href="https://t.me/MikuNaNChannel?direct"><i>联系</i></a><i> 删除。</i><br/><br/>',
  '<i class="emoji"><b>📢</b></i> 防失联频道： ',
  '<a href="https://t.me/MikuNaNChannel">@MikuNaNChannel</a>',
  "</div></body></html>",
].join("");

function installTelegramFetchMock({ fail, webhookInfo, announcementHtml = ANNOUNCEMENT_EMBED_HTML, announcementStatus = 200 } = {}) {
  let nextMessageId = 100;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === ANNOUNCEMENT_EMBED_URL) {
      calls.push({ url: target, method: "announcementEmbed", payload: {} });
      return new Response(announcementHtml, {
        status: announcementStatus,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    let payload = {};
    try {
      payload = init.body ? JSON.parse(init.body) : {};
    } catch {
      payload = {};
    }
    calls.push({ url: target, method: target.slice(target.lastIndexOf("/") + 1), payload });
    const method = target.slice(target.lastIndexOf("/") + 1);
    const error = fail?.(method, payload);
    if (error) return new Response(JSON.stringify({ ok: false, description: error }), { status: 400 });
    const result = method === "getWebhookInfo"
      ? (typeof webhookInfo === "function" ? webhookInfo(calls) : (webhookInfo || {}))
      : { message_id: ++nextMessageId };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    method(name) {
      return calls.filter((call) => call.method === name);
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function configureTelegram(env, chatId = CHAT_ID) {
  const response = await handleAdminTelegramSettings(
    new Request("https://example.com/api/admin/telegram", {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ enabled: true, chatId, botToken: BOT_TOKEN }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, true);
  assert.equal(body.commandsConfigured, true);
  const setWebhook = mock.calls.find((call) => call.method === "setWebhook");
  assert.ok(setWebhook, "expected a setWebhook call");
  const menuButton = mock.method("setChatMenuButton").at(-1);
  assert.ok(menuButton, "expected a command menu button");
  assert.deepEqual(menuButton.payload.menu_button, { type: "commands" });
  const commandCalls = mock.method("setMyCommands");
  assert.equal(commandCalls.length, 2, "expected default and reviewer command menus");
  const defaultCommands = commandCalls.find((call) => call.payload.scope === undefined);
  const reviewerCommands = commandCalls.find((call) => call.payload.scope?.type === "chat");
  assert.deepEqual(
    defaultCommands.payload.commands.map((item) => item.command),
    ["start", "icons", "help", "submit", "my"],
  );
  const commandDescriptions = Object.fromEntries(
    defaultCommands.payload.commands.map((item) => [item.command, item.description]),
  );
  assert.equal(commandDescriptions.start, "快速开始");
  assert.equal(commandDescriptions.icons, "获取图标库地址");
  assert.equal(commandDescriptions.help, "查看帮助");
  assert.deepEqual(
    reviewerCommands.payload.commands.map((item) => item.command),
    ["start", "icons", "help", "submit", "my", "queue", "cancel", "reject", "skip"],
  );
  assert.equal(reviewerCommands.payload.scope.chat_id, Number(chatId));
  return String(setWebhook.payload.url).slice(String(setWebhook.payload.url).lastIndexOf("/") + 1);
}

let mock;

function webhookRequest(secret, update) {
  return new Request(`https://example.com/api/telegram/webhook/${secret}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(update),
  });
}

function stateKey(userId = USER_ID, chatId = CHAT_ID) {
  return `settings/telegram/review/${chatId}/${userId}`;
}

function pendingState(env, userId = USER_ID, chatId = CHAT_ID) {
  const raw = env.__kv.get(stateKey(userId, chatId));
  return raw ? JSON.parse(raw) : null;
}

function lastReviewEdit(messageId = 10) {
  return mock.calls
    .filter((call) => call.method === "editMessageText" || call.method === "editMessageCaption")
    .filter((call) => call.payload.message_id === messageId)
    .at(-1);
}

function lastCardSend() {
  return mock.calls.filter((call) => call.method === "sendPhoto" || call.method === "sendMessage").at(-1);
}

function lastSubmissionEntry() {
  return mock.method("sendMessage").filter((call) =>
    call.payload.reply_markup?.inline_keyboard?.flat()
      .some((button) => String(button.url || button.web_app?.url || "").includes("/submit"))
  ).at(-1);
}

function cardText(call) {
  return call?.payload?.caption || call?.payload?.text || "";
}

function buttonData(action, messageId = 10) {
  return lastReviewEdit(messageId)?.payload.reply_markup?.inline_keyboard.flat()
    .find((button) => button.callback_data?.startsWith(action + ":"))?.callback_data;
}

function message(secret, env, text, messageId = 11, options = {}) {
  const { userId = USER_ID, chatId = CHAT_ID, chatType = "private", replyTo } = options;
  return handleTelegramWebhook(
    webhookRequest(secret, {
      message: {
        chat: { id: chatId, type: chatType }, from: { id: userId }, message_id: messageId, text,
        ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
      },
    }), env, secret,
  );
}

function callback(secret, env, data, callbackId = "cb-1", options = {}) {
  const { userId = USER_ID, chatId = CHAT_ID, chatType = "private", messageId = 10, text = "original", photo } = options;
  return handleTelegramWebhook(
    webhookRequest(secret, {
      callback_query: {
        id: callbackId, from: { id: userId }, data,
        message: { chat: { id: chatId, type: chatType }, message_id: messageId, ...(photo ? { photo } : { text }) },
      },
    }), env, secret,
  );
}

test("telegram notification flags a conflicting submission and offers recovery buttons", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "okemby", "https://example.com/new.png");

    await notifyNewSubmission(env, { id, name: "OkEmby", url: "https://example.com/new.png", note: "" }, "https://example.com");

    const send = lastCardSend();
    assert.ok(send, "expected a card send");
    assert.match(cardText(send), /名称冲突/);
    const buttons = send.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(buttons.includes(`rename:${id}:0`));
    assert.ok(buttons.includes(`replace:${id}`));
    assert.ok(buttons.includes(`reject:${id}`));
    assert.ok(!buttons.includes(`approve:${id}`));
    // Conflict state is stored so rename buttons stay resolvable.
    assert.ok(env.__kv.has(`settings/telegram/conflict/${id}`));
  } finally {
    mock.restore();
  }
});

test("approving a conflicting submission via Telegram redraws the conflict keyboard", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    const response = await callback(secret, env, `approve:${id}`);
    assert.equal(response.status, 200);
    // Approving is two-step: the first tap only asks for confirmation.
    assert.match(lastReviewEdit().payload.text, /确认通过并发布/);

    await callback(secret, env, buttonData("approve-confirm"));

    const edit = lastReviewEdit();
    assert.ok(edit, "expected an editMessageText call");
    assert.match(edit.payload.text, /名称冲突/);
    const buttons = edit.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(buttons.includes(`rename:${id}:0`));
    assert.ok(buttons.includes(`replace:${id}`));
    // The submission must remain pending and unpublished.
    assert.equal(env.DB.submissions.get(id).status, "pending");
    assert.equal(readKv(env).icons.length, 1);
  } finally {
    mock.restore();
  }
});

test("renaming via Telegram publishes under the suggested name", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    await notifyNewSubmission(env, { id, name: "OkEmby", url: "https://example.com/new.png", note: "" }, "https://example.com");
    const response = await callback(secret, env, `rename:${id}:0`);
    assert.equal(response.status, 200);

    const icons = readKv(env).icons;
    assert.deepEqual(icons.map((icon) => icon.name), ["OkEmby", "OkEmby01"]);
    assert.equal(env.DB.submissions.get(id).status, "approved");
    assert.equal(env.DB.submissions.get(id).name, "OkEmby01");
    const answer = mock.method("answerCallbackQuery").at(-1);
    assert.match(answer.payload.text, /正在改名并发布/);
    assert.match(lastReviewEdit().payload.text, /已改名为「OkEmby01」/);
  } finally {
    mock.restore();
  }
});

test("manual rename via Telegram publishes under the typed name", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    await notifyNewSubmission(env, { id, name: "OkEmby", url: "https://example.com/new.png", note: "" }, "https://example.com");
    const buttons = lastCardSend().payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(buttons.includes(`rename-manual:${id}`), "expected a manual rename button");

    await callback(secret, env, `rename-manual:${id}`);
    assert.ok(env.__kv.has(stateKey()));

    await message(secret, env, "OkEmbyCustom");
    const icons = readKv(env).icons;
    assert.deepEqual(icons.map((icon) => icon.name), ["OkEmby", "OkEmbyCustom"]);
    assert.equal(env.DB.submissions.get(id).status, "approved");
    assert.equal(env.DB.submissions.get(id).name, "OkEmbyCustom");
    assert.ok(!env.__kv.has(stateKey()), "rename state should be cleared");
  } finally {
    mock.restore();
  }
});

test("manual rename prompt uses the submission name instead of a fixed example", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "MyEmbyIcon", "https://example.com/new.png");

    await callback(secret, env, `rename-manual:${id}`);

    // The hint is folded into the card itself; no separate prompt is sent.
    const edit = lastReviewEdit();
    assert.match(edit.payload.text, /请回复新的图标名称/);
    assert.match(edit.payload.text, /当前名称：MyEmbyIcon/);
    assert.match(edit.payload.text, /\/cancel/);
    assert.doesNotMatch(edit.payload.text, /OkEmby02/);
    assert.match(edit.payload.text, /等待新名称/);
    assert.doesNotMatch(edit.payload.text, /例如 OkEmby02/);
  } finally {
    mock.restore();
  }
});

test("manual rename prompt offers the conflict suggestion derived from that submission", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");
    await notifyNewSubmission(env, { id, name: "OkEmby", url: "https://example.com/new.png", note: "" }, "https://example.com");

    await callback(secret, env, `rename-manual:${id}`);

    const text = lastReviewEdit().payload.text;
    assert.match(text, /当前名称：OkEmby/);
    assert.match(text, /建议名称（可直接回复其中一个）：OkEmby01、OkEmby02/);
  } finally {
    mock.restore();
  }
});

test("manual rename that still conflicts stays open and redraws the buttons", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    await callback(secret, env, `rename-manual:${id}`);
    await message(secret, env, "OkEmby");

    assert.equal(env.DB.submissions.get(id).status, "pending");
    assert.ok(env.__kv.has(stateKey()), "rename flow should stay open");
    const edit = lastReviewEdit();
    assert.match(edit.payload.text, /名称冲突/);
    const buttons = edit.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(buttons.includes(`rename-manual:${id}`));
    assert.ok(buttons.includes(`replace:${id}`));
  } finally {
    mock.restore();
  }
});

test("cancelling a manual rename restores the review buttons", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    await callback(secret, env, `rename-manual:${id}`);
    await message(secret, env, "/cancel");

    assert.ok(!env.__kv.has(stateKey()));
    assert.equal(env.DB.submissions.get(id).status, "pending");
    const edit = lastReviewEdit();
    assert.match(edit.payload.text, /取消改名/);
    const buttons = edit.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(buttons.includes(`rename:${id}:0`));
  } finally {
    mock.restore();
  }
});

test("replacing via Telegram overwrites the existing icon", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [{ name: "OkEmby", url: "https://example.com/existing.png" }] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    const response = await callback(secret, env, `replace:${id}`);
    assert.equal(response.status, 200);
    assert.equal(env.DB.submissions.get(id).status, "pending");
    assert.equal(readKv(env).icons[0].url, "https://example.com/existing.png");
    await callback(secret, env, buttonData("replace-confirm"));

    const icons = readKv(env).icons;
    assert.equal(icons.length, 1);
    assert.equal(icons[0].url, "https://example.com/new.png");
    assert.equal(env.DB.submissions.get(id).status, "approved");
  } finally {
    mock.restore();
  }
});

test("webhook ignores callbacks from an unauthorized chat", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment();
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "Demo", "https://example.com/demo.png");

    await handleTelegramWebhook(
      webhookRequest(secret, {
        callback_query: {
          id: "cb-9",
          data: `approve:${id}`,
          message: { chat: { id: "999" }, message_id: 10, text: "original" },
        },
      }),
      env,
      secret,
    );

    assert.equal(mock.method("editMessageText").length, 0);
    assert.equal(env.DB.submissions.get(id).status, "pending");
  } finally {
    mock.restore();
  }
});

test("plain review messages offer a manual rename", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    await notifyNewSubmission(env, { id, name: "OkEmby", url: "https://example.com/new.png", note: "" }, "https://example.com");
    const buttons = lastCardSend().payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(buttons.includes(`approve:${id}`));
    assert.ok(buttons.includes(`rename-manual:${id}`), "expected a manual rename button on a plain review");

    await callback(secret, env, `rename-manual:${id}`);
    await message(secret, env, "OkEmby02");

    assert.deepEqual(readKv(env).icons.map((icon) => icon.name), ["OkEmby02"]);
    assert.equal(env.DB.submissions.get(id).name, "OkEmby02");
    assert.equal(env.DB.submissions.get(id).status, "approved");
  } finally {
    mock.restore();
  }
});

test("replying with free text records the rejection reason", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    await notifyNewSubmission(env, { id, name: "OkEmby", url: "https://example.com/new.png", note: "" }, "https://example.com");
    await callback(secret, env, `reject:${id}`);
    assert.ok(env.__kv.has(stateKey()), "expected a pending reject state");

    await message(secret, env, "图片模糊，请重新上传");

    const row = env.DB.submissions.get(id);
    assert.equal(row.status, "rejected");
    assert.equal(row.reviewer_note, "图片模糊，请重新上传");
    assert.ok(!env.__kv.has(stateKey()), "reject state should be cleared");
  } finally {
    mock.restore();
  }
});

test("bare /reject rejects without a reason", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "OkEmby", "https://example.com/new.png");

    await callback(secret, env, `reject:${id}`);
    await message(secret, env, "/reject");

    const row = env.DB.submissions.get(id);
    assert.equal(row.status, "rejected");
    assert.equal(row.reviewer_note, "");
  } finally {
    mock.restore();
  }
});

function telegramTest(name, run, options = {}) {
  test(name, async () => {
    mock = installTelegramFetchMock(options.mock || {});
    try {
      const env = createEnvironment({ icons: options.icons || [] });
      const secret = await configureTelegram(env, options.chatId || CHAT_ID);
      await run({ env, secret });
    } finally {
      mock.restore();
    }
  });
}

telegramTest("reject menu offers common reasons and a scoped cancel button", async ({ env, secret }) => {
  const id = await createSubmission(env, "QuickReject", "https://example.com/reject.png");
  await callback(secret, env, `reject:${id}`);
  // The rejection hint lives on the card; nothing forces a reply/quote.
  assert.match(lastReviewEdit().payload.text, /请回复「QuickReject」的拒绝原因/);
  assert.match(lastReviewEdit().payload.text, /无需引用消息/);
  assert.ok(buttonData("cancel"));
  assert.equal(env.DB.submissions.get(id).status, "pending");
  const preset = buttonData("reject-preset");
  await callback(secret, env, preset);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
  assert.equal(env.DB.submissions.get(id).reviewer_note, "图片模糊或质量不佳");
  assert.equal(pendingState(env), null);
  assert.deepEqual(lastReviewEdit().payload.reply_markup.inline_keyboard, []);
  assert.match(lastReviewEdit().payload.text, /已拒绝\n原因：图片模糊或质量不佳/);
  assert.equal(readKv(env).icons.length, 0);
});

telegramTest("a rejection reuses the card in place instead of sending a second prompt", async ({ env, secret }) => {
  const id = await createSubmission(env, "CleanPrompt", "https://example.com/clean.png");
  await callback(secret, env, `reject:${id}`);
  assert.equal(pendingState(env).promptMessageId, undefined, "no separate prompt message");
  const sentBefore = mock.method("sendMessage").length;
  await message(secret, env, "/reject", 12);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
  // Nothing extra is posted; only the review card is edited in place.
  assert.equal(mock.method("sendMessage").length, sentBefore);
  assert.equal(pendingState(env), null);
});

telegramTest("empty rejection requires the explicit confirmation button", async ({ env, secret }) => {
  const id = await createSubmission(env, "EmptyReject", "https://example.com/reject.png");
  await callback(secret, env, `reject:${id}`);
  const data = buttonData("reject-empty");
  await callback(secret, env, data);
  await callback(secret, env, data);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
  assert.equal(env.DB.submissions.get(id).reviewer_note, "");
  assert.equal(env.DB.auditLogs.filter((log) => log.action === "submission-rejected").length, 1);
});

telegramTest("inline cancellation restores the current conflict-aware card", async ({ env, secret }) => {
  const id = await createSubmission(env, "Existing", "https://example.com/new.png");
  await callback(secret, env, `replace:${id}`);
  await callback(secret, env, buttonData("cancel"));
  assert.equal(pendingState(env), null);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.ok(buttonData("replace"));
  assert.ok(buttonData("rename"));
  assert.match(lastReviewEdit().payload.text, /已取消替换/);
}, { icons: [{ name: "Existing", url: "https://example.com/old.png" }] });

telegramTest("an old confirmation cannot execute or cancel a newer review flow", async ({ env, secret }) => {
  const id = await createSubmission(env, "Confirm", "https://example.com/new.png");
  await callback(secret, env, `replace:${id}`);
  const oldConfirm = buttonData("replace-confirm");
  const oldCancel = buttonData("cancel");
  await callback(secret, env, `replace:${id}`);
  const current = pendingState(env);
  await callback(secret, env, oldConfirm);
  await callback(secret, env, oldCancel);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.equal(pendingState(env).nonce, current.nonce);
  assert.match(mock.method("sendMessage").at(-1).payload.text, /已失效/);
});

telegramTest("replacement asks again when the existing icon changes before confirmation", async ({ env, secret }) => {
  const id = await createSubmission(env, "Existing", "https://example.com/new.png");
  await callback(secret, env, `replace:${id}`);
  const oldConfirm = buttonData("replace-confirm");
  const document = readKv(env);
  document.icons[0].url = "https://example.com/changed.png";
  await env.EMBY_ICONS.put("emby-icons.json", JSON.stringify(document));
  await callback(secret, env, oldConfirm);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.equal(readKv(env).icons[0].url, "https://example.com/changed.png");
  assert.match(lastReviewEdit().payload.text, /changed.png/);
  assert.notEqual(buttonData("replace-confirm"), oldConfirm);
  await callback(secret, env, buttonData("replace-confirm"));
  assert.equal(readKv(env).icons[0].url, "https://example.com/new.png");
}, { icons: [{ name: "Existing", url: "https://example.com/old.png" }] });

telegramTest("review callbacks and messages from groups are ignored", async ({ env, secret }) => {
  const chatId = "-100123";
  const id = await createSubmission(env, "GroupReview", "https://example.com/group.png");
  const options = { chatId, chatType: "supergroup" };
  await callback(secret, env, `reject:${id}`, "group", options);
  await message(secret, env, "确实无法访问", 20, options);
  await message(secret, env, "/reject", 21, options);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.equal(pendingState(env, USER_ID, chatId), null);
  assert.equal(mock.method("sendMessage").length, 0);
  assert.equal(mock.method("forwardMessage").length, 0);
});

telegramTest("one reviewer cannot press another reviewer's confirmation", async ({ env, secret }) => {
  const id = await createSubmission(env, "Scoped", "https://example.com/scoped.png");
  await callback(secret, env, `reject:${id}`);
  const confirm = buttonData("reject-empty");
  await callback(secret, env, confirm, "other", { userId: "1002" });
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.ok(pendingState(env));
  await callback(secret, env, confirm);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
});

telegramTest("different reviewers keep independent input sessions", async ({ env, secret }) => {
  const a = await createSubmission(env, "ReviewerA", "https://example.com/a.png");
  const b = await createSubmission(env, "ReviewerB", "https://example.com/b.png");
  await callback(secret, env, `rename-manual:${a}`);
  await callback(secret, env, `reject:${b}`, "other", { userId: "1002", messageId: 20 });
  await message(secret, env, "AName");
  assert.equal(env.DB.submissions.get(a).name, "AName");
  assert.equal(env.DB.submissions.get(b).status, "pending");
  assert.equal(pendingState(env, "1002").id, b);
  await message(secret, env, "重复图标", 21, { userId: "1002" });
  assert.equal(env.DB.submissions.get(b).reviewer_note, "重复图标");
});

telegramTest("switching submissions restores the old card and ignores replies to its old card", async ({ env, secret }) => {
  const a = await createSubmission(env, "OldFlow", "https://example.com/a.png");
  const b = await createSubmission(env, "NewFlow", "https://example.com/b.png");
  await callback(secret, env, `rename-manual:${a}`);
  const oldCard = pendingState(env).messageId;
  await callback(secret, env, `reject:${b}`, "b", { messageId: 20 });
  assert.equal(pendingState(env).id, b);
  assert.match(lastReviewEdit(10).payload.text, /已切换/);
  assert.ok(buttonData("approve", 10));
  await message(secret, env, "不应成为拒绝原因", 21, { replyTo: oldCard });
  assert.equal(env.DB.submissions.get(a).status, "pending");
  assert.equal(env.DB.submissions.get(b).status, "pending");
  await message(secret, env, "正确拒绝原因", 22, { replyTo: pendingState(env).messageId });
  assert.equal(env.DB.submissions.get(b).reviewer_note, "正确拒绝原因");
});

telegramTest("switching rename to reject never publishes the rejection text as a name", async ({ env, secret }) => {
  const id = await createSubmission(env, "Switch", "https://example.com/switch.png");
  await callback(secret, env, `rename-manual:${id}`);
  await callback(secret, env, `reject:${id}`);
  assert.equal(pendingState(env).action, "reject");
  await message(secret, env, "图片模糊");
  assert.equal(env.DB.submissions.get(id).status, "rejected");
  assert.equal(env.DB.submissions.get(id).name, "Switch");
  assert.equal(readKv(env).icons.length, 0);
});

telegramTest("starting an approval on another card replaces the previous flow safely", async ({ env, secret }) => {
  const a = await createSubmission(env, "StillWaiting", "https://example.com/a.png");
  const b = await createSubmission(env, "ApprovedNow", "https://example.com/b.png");
  await callback(secret, env, `rename-manual:${a}`);
  await callback(secret, env, `approve:${b}`, "b", { messageId: 20 });
  assert.equal(pendingState(env).id, b);
  assert.equal(pendingState(env).action, "approve");
  // Free text while a confirmation is pending must not publish or reject anything.
  await message(secret, env, "StillWaitingRenamed");
  assert.equal(env.DB.submissions.get(a).status, "pending");
  assert.equal(env.DB.submissions.get(b).status, "pending");
  assert.match(mock.method("sendMessage").at(-1).payload.text, /确认通过并发布/);
  await callback(secret, env, buttonData("approve-confirm", 20), "confirm", { messageId: 20 });
  assert.equal(env.DB.submissions.get(b).status, "approved");
  assert.equal(env.DB.submissions.get(a).status, "pending");
});

telegramTest("stale buttons on resolved submissions show the real status without starting a new prompt", async ({ env, secret }) => {
  const id = await createSubmission(env, "Resolved", "https://example.com/done.png");
  env.DB.submissions.get(id).status = "withdrawn";
  const sentBefore = mock.method("sendMessage").length;
  for (const action of ["reject", "replace", "rename-manual", "approve"]) {
    await callback(secret, env, `${action}:${id}`);
    assert.match(lastReviewEdit().payload.text, /已撤回/);
    assert.deepEqual(lastReviewEdit().payload.reply_markup.inline_keyboard, []);
  }
  assert.equal(pendingState(env), null);
  assert.equal(mock.method("sendMessage").length, sentBefore);
  assert.equal(readKv(env).icons.length, 0);
});

telegramTest("a reply after web review clears the old input without changing the verdict", async ({ env, secret }) => {
  const id = await createSubmission(env, "ReviewedElsewhere", "https://example.com/elsewhere.png");
  await callback(secret, env, `rename-manual:${id}`);
  env.DB.submissions.get(id).status = "rejected";
  env.DB.submissions.get(id).reviewer_note = "网页端已拒绝";
  await message(secret, env, "ShouldNotPublish");
  assert.equal(pendingState(env), null);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
  assert.equal(readKv(env).icons.length, 0);
  assert.match(lastReviewEdit().payload.text, /网页端已拒绝/);
});

telegramTest("expired input restores the review card instead of executing a late reply", async ({ env, secret }) => {
  const id = await createSubmission(env, "Expired", "https://example.com/expired.png");
  await callback(secret, env, `reject:${id}`);
  const state = pendingState(env);
  state.createdAt = Date.now() - 11 * 60 * 1000;
  await env.EMBY_ICONS.put(stateKey(), JSON.stringify(state));
  await message(secret, env, "迟到的拒绝原因");
  assert.equal(pendingState(env), null);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.match(lastReviewEdit().payload.text, /已超时/);
  assert.ok(buttonData("approve"));
});

telegramTest("expired replacement confirmation never overwrites the icon", async ({ env, secret }) => {
  const id = await createSubmission(env, "ExpiredReplace", "https://example.com/new.png");
  await callback(secret, env, `replace:${id}`);
  const data = buttonData("replace-confirm");
  const state = pendingState(env);
  state.createdAt = Date.now() - 11 * 60 * 1000;
  await env.EMBY_ICONS.put(stateKey(), JSON.stringify(state));
  await callback(secret, env, data);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.equal(readKv(env).icons[0].url, "https://example.com/old.png");
}, { icons: [{ name: "ExpiredReplace", url: "https://example.com/old.png" }] });

telegramTest("card redraws replace old status instead of accumulating previous prompts", async ({ env, secret }) => {
  const id = await createSubmission(env, "CleanCard", "https://example.com/card.png");
  for (let index = 0; index < 3; index++) {
    const text = lastReviewEdit()?.payload.text || "legacy card\n⏳ 等待拒绝原因";
    await callback(secret, env, `rename-manual:${id}`, `rename-${index}`, { text });
    await callback(secret, env, buttonData("cancel"), `cancel-${index}`, { text: lastReviewEdit().payload.text });
  }
  const text = lastReviewEdit().payload.text;
  assert.equal((text.match(/Emby 图标审核/g) || []).length, 1);
  assert.equal((text.match(/已取消改名/g) || []).length, 1);
  assert.doesNotMatch(text, /legacy card|等待拒绝原因|等待新名称/);
});

telegramTest("long content fits message limits and callback data stays under 64 bytes", async ({ env, secret }) => {
  const id = await createSubmission(env, "Long", "https://example.com/long.png");
  const row = env.DB.submissions.get(id);
  row.name = "长".repeat(120);
  row.note = "说明".repeat(500);
  row.url = "https://example.com/" + "a".repeat(2000);
  await notifyNewSubmission(env, row, "https://example.com");
  await callback(secret, env, `reject:${id}`);
  await message(secret, env, "拒".repeat(1000));
  for (const call of mock.calls) {
    if (call.payload.text) assert.ok(call.payload.text.length <= 4096);
    if (call.payload.caption) assert.ok(call.payload.caption.length <= 1024);
    for (const button of call.payload.reply_markup?.inline_keyboard?.flat() || []) {
      if (!button.callback_data) continue;
      assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
    }
  }
  assert.equal(row.reviewer_note.length, 1000);
});

telegramTest("invalid names keep the flow open and re-prompt on the card", async ({ env, secret }) => {
  const id = await createSubmission(env, "Validation", "https://example.com/validation.png");
  await callback(secret, env, `rename-manual:${id}`);
  await message(secret, env, "a".repeat(121));
  assert.ok(pendingState(env), "the input session should stay open");
  assert.match(lastReviewEdit().payload.text, /1-120/);
  // Plain text (no reply/quote) still completes the rename.
  await message(secret, env, "ValidName", 22);
  assert.equal(env.DB.submissions.get(id).name, "ValidName");
});

telegramTest("bot-addressed cancel and reject commands work in private chats", async ({ env, secret }) => {
  const id = await createSubmission(env, "Commands", "https://example.com/commands.png");
  await callback(secret, env, `rename-manual:${id}`);
  await message(secret, env, "/cancel@ReviewBot");
  assert.equal(pendingState(env), null);
  await callback(secret, env, `reject:${id}`);
  await message(secret, env, "/reject@ReviewBot 自定义拒绝原因");
  assert.equal(env.DB.submissions.get(id).reviewer_note, "自定义拒绝原因");
});

telegramTest("callback acknowledgement precedes database work", async ({ env, secret }) => {
  const id = await createSubmission(env, "FastAck", "https://example.com/ack.png");
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    assert.ok(mock.method("answerCallbackQuery").length > 0);
    return prepare(sql);
  };
  await callback(secret, env, `approve:${id}`);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.equal(mock.method("answerCallbackQuery").length, 1);
  await callback(secret, env, buttonData("approve-confirm"));
  assert.equal(env.DB.submissions.get(id).status, "approved");
  assert.equal(mock.method("answerCallbackQuery").length, 2);
});

telegramTest("completed decisions fall back to a result message when the card cannot be edited", async ({ env, secret }) => {
  const id = await createSubmission(env, "MissingCard", "https://example.com/missing.png");
  await callback(secret, env, `approve:${id}`);
  await callback(secret, env, buttonData("approve-confirm"));
  assert.equal(env.DB.submissions.get(id).status, "approved");
  assert.match(mock.method("sendMessage").at(-1).payload.text, /已通过并发布/);
}, { mock: { fail: (() => {
  let edits = 0;
  return (method) => (method === "editMessageText" && ++edits > 1) ? "Bad Request: message to edit not found" : "";
})() } });

telegramTest("a failed card edit leaves no invisible input session", async ({ env, secret }) => {
  const id = await createSubmission(env, "PromptFailure", "https://example.com/prompt.png");
  await callback(secret, env, `rename-manual:${id}`);
  assert.equal(pendingState(env), null);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.match(mock.method("sendMessage").at(-1).payload.text, /审核卡片更新失败/);
}, { mock: { fail: (method) => (method === "editMessageText" || method === "editMessageCaption") ? "Telegram unavailable" : "" } });

telegramTest("disabling notifications keeps private commands available", async ({ env, secret }) => {
  const config = JSON.parse(env.__kv.get("settings/telegram.json"));
  config.enabled = false;
  await env.EMBY_ICONS.put("settings/telegram.json", JSON.stringify(config));

  const response = await message(secret, env, "/submit", 32, { userId: "9010", chatId: "9010" });
  assert.equal(response.status, 200);
  const entry = lastSubmissionEntry();
  assert.ok(entry, "expected /submit to reply even when notifications are disabled");
  assert.equal(entry.payload.chat_id, "9010");
  assert.equal(await notifyNewSubmission(env, { id: "disabled", name: "Disabled", url: "https://example.com/disabled.png", note: "" }), false);
});


test("legacy chat-scoped input can be cancelled without applying its text", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment();
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "Legacy", "https://example.com/legacy.png");
    const legacyKey = `settings/telegram/reject/${CHAT_ID}`;
    await env.EMBY_ICONS.put(legacyKey, JSON.stringify({ id, messageId: 10, messageText: "legacy card", createdAt: Date.now() }));
    await message(secret, env, "/cancel");
    assert.ok(!env.__kv.has(legacyKey));
    assert.equal(env.DB.submissions.get(id).status, "pending");
    assert.match(lastReviewEdit().payload.text, /旧版输入已取消/);
    assert.ok(buttonData("approve"));
  } finally {
    mock.restore();
  }
});

test("replacement restores the card when the new icon document cannot be validated", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const id = await createSubmission(env, "BrokenDocument", "https://example.com/broken.png");
    await env.EMBY_ICONS.put("emby-icons.json", "{not-json");
    await callback(secret, env, `replace:${id}`);
    assert.equal(pendingState(env), null);
    assert.equal(env.DB.submissions.get(id).status, "pending");
    assert.match(lastReviewEdit().payload.text, /待审核/);
    assert.ok(buttonData("approve"));
    assert.match(mock.method("sendMessage").at(-1).payload.text, /无法读取当前图标库/);
  } finally {
    mock.restore();
  }
});


test("/start forwards the channel announcement to any user", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/start", 21, { userId: "9001", chatId: "9001" });

    const forward = mock.method("forwardMessage").at(-1);
    assert.ok(forward, "expected the announcement to be forwarded");
    assert.equal(forward.payload.chat_id, "9001");
    assert.equal(forward.payload.from_chat_id, "@MikuNaNChannel");
    assert.equal(forward.payload.message_id, 8);
    const entry = lastSubmissionEntry();
    assert.ok(entry, "expected a submission entry after the announcement");
    assert.equal(entry.payload.chat_id, "9001");
    assert.match(entry.payload.text, /审核通过后会收录到公开图标库/);
    const buttons = entry.payload.reply_markup.inline_keyboard;
    assert.equal(buttons[0][0].text, "🖼 提交图标");
    assert.equal(
      buttons[0][0].web_app.url,
      "https://example.com/submit?startapp=channel8",
    );
    assert.equal(buttons[0][0].url, undefined);
    assert.equal(buttons[1][0].text, "📋 我的提交");
    assert.deepEqual(buttons[2][0], { text: "🖼 获取图标", callback_data: "icons:show" });
  } finally {
    mock.restore();
  }
});

test("/icons directly forwards the channel announcement without an extra message", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/icons@MikuNaNBot", 21, { userId: "9001", chatId: "9001" });

    const forwards = mock.method("forwardMessage");
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].payload.chat_id, "9001");
    assert.equal(forwards[0].payload.from_chat_id, "@MikuNaNChannel");
    assert.equal(forwards[0].payload.message_id, 8);
    assert.equal(mock.method("copyMessage").length, 0);
    assert.equal(mock.method("sendMessage").length, 0, "a successful /icons reply should be the forward itself");
  } finally {
    mock.restore();
  }
});

test("/icons keeps the channel content when forwarding is blocked", async () => {
  mock = installTelegramFetchMock({
    fail: (method) => (method === "forwardMessage" ? "message can't be forwarded" : undefined),
  });
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/icons", 22, { userId: "9002", chatId: "9002" });

    const copy = mock.method("copyMessage").at(-1);
    assert.ok(copy, "expected a copy fallback");
    assert.equal(copy.payload.chat_id, "9002");
    assert.equal(copy.payload.from_chat_id, "@MikuNaNChannel");
    assert.equal(copy.payload.message_id, 8);
    assert.equal(mock.method("sendMessage").length, 0, "the copy is the complete /icons reply");
  } finally {
    mock.restore();
  }
});

test("/start offers icon retrieval and /help omits channel announcements", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const options = { userId: "9010", chatId: "9010" };

    await message(secret, env, "/start", 21, options);
    await message(secret, env, "/start", 22, options);
    await message(secret, env, "/help", 23, options);
    await message(secret, env, "/help", 24, options);

    const forwards = mock.method("forwardMessage");
    assert.equal(forwards.length, 2, "only /start should forward the channel post");
    assert.ok(forwards.every((call) => (
      call.payload.chat_id === "9010"
      && call.payload.from_chat_id === "@MikuNaNChannel"
      && call.payload.message_id === 8
    )));

    const helps = mock.method("sendMessage").filter((call) => (
      call.payload.parse_mode === "HTML"
      && String(call.payload.text || "").includes("📖 <b>Emby 图标库帮助</b>")
    ));
    assert.equal(helps.length, 2, "each /help should send one help card");
    assert.ok(helps.every((call) => {
      const text = String(call.payload.text || "");
      return text.includes("• /icons — 获取图标库地址")
        && !text.includes("频道公告")
        && !text.includes("Emby 自用图标库")
        && !text.includes("emby-icons.json");
    }));
    const helpButtons = helps[0].payload.reply_markup.inline_keyboard;
    assert.equal(helpButtons[0][0].text, "🖼 提交图标");
    assert.equal(helpButtons[1][0].text, "📋 我的提交");
    assert.deepEqual(helpButtons[2][0], { text: "🖼 获取图标", callback_data: "icons:show" });

    const entries = mock.method("sendMessage").filter((call) => (
      /需要提交图标/.test(String(call.payload.text || ""))
    ));
    assert.equal(entries.length, 2, "each /start should offer the follow-up entry buttons");
    assert.ok(entries.every((call) => {
      const buttons = call.payload.reply_markup.inline_keyboard;
      return buttons[0][0].text === "🖼 提交图标"
        && buttons[1][0].text === "📋 我的提交"
        && buttons[2][0].text === "🖼 获取图标"
        && buttons[2][0].callback_data === "icons:show";
    }));
    assert.equal(mock.method("announcementEmbed").length, 0, "help must not load the channel post");

    const replyText = mock.method("sendMessage")
      .map((call) => String(call.payload.text || ""))
      .join("\n");
    assert.doesNotMatch(replyText, /查看公告|频道公告|帮助内容已发送。|重新查看公告/);
  } finally {
    mock.restore();
  }
});

test("/help sends a standalone formatted help card to the admin", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/help@MikuNaNBot", 22);

    const sends = mock.method("sendMessage");
    assert.equal(sends.length, 1, "help should send exactly one card");
    const help = sends[0];
    assert.equal(help.payload.chat_id, CHAT_ID);
    assert.equal(help.payload.parse_mode, "HTML");
    const text = String(help.payload.text || "");
    assert.match(text, /📖 <b>Emby 图标库帮助<\/b>/);
    assert.match(text, /<b>提交与查询<\/b>/);
    assert.match(text, /• \/icons — 获取图标库地址/);
    assert.match(text, /• \/my — 打开我的提交页面/);
    assert.match(text, /<b>提交要求<\/b>/);
    assert.match(text, /<b>常见问题<\/b>/);
    assert.doesNotMatch(text, /频道公告|Emby 自用图标库|emby-icons\.json/);
    const buttons = help.payload.reply_markup.inline_keyboard;
    assert.equal(buttons[0][0].text, "🖼 提交图标");
    assert.equal(buttons[1][0].text, "📋 我的提交");
    assert.deepEqual(buttons[2][0], { text: "🖼 获取图标", callback_data: "icons:show" });
    assert.equal(mock.method("forwardMessage").length, 0, "help must not forward the channel post");
    assert.equal(mock.method("announcementEmbed").length, 0);
  } finally {
    mock.restore();
  }
});

test("获取图标 callback returns the same channel content as /icons", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await callback(secret, env, "icons:show", "icons-button", {
      userId: "9020",
      chatId: "9020",
      messageId: 33,
    });

    let forwards = mock.method("forwardMessage");
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].payload.chat_id, "9020");
    assert.equal(forwards[0].payload.from_chat_id, "@MikuNaNChannel");
    assert.equal(forwards[0].payload.message_id, 8);
    assert.equal(mock.method("answerCallbackQuery").at(-1).payload.text, "正在获取图标…");
    assert.equal(mock.method("sendMessage").length, 0, "the forwarded post is the complete reply");

    await callback(secret, env, "announcement:show", "legacy-button", {
      userId: "9021",
      chatId: "9021",
      messageId: 34,
    });
    forwards = mock.method("forwardMessage");
    assert.equal(forwards.length, 2, "old 查看公告 buttons should now return icons content");
    assert.equal(forwards[1].payload.chat_id, "9021");
    assert.equal(mock.method("sendMessage").length, 0);
  } finally {
    mock.restore();
  }
});

test("/submit opens the submission Mini App from a private chat", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/submit", 28, { userId: "9006", chatId: "9006" });

    const entry = mock.method("sendMessage").at(-1);
    const button = entry.payload.reply_markup.inline_keyboard[0][0];
    assert.match(entry.payload.text, /打开图标提交页面/);
    assert.equal(button.text, "🖼 打开图标提交");
    assert.equal(button.web_app.url, "https://example.com/submit?startapp=command");
    assert.equal(button.url, undefined);
    assert.equal(mock.method("forwardMessage").length, 0);
  } finally {
    mock.restore();
  }
});

test("group commands are ignored completely", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/submit@MikuNaNBot", 29, { chatId: "-10099", chatType: "group" });
    await message(secret, env, "/start@MikuNaNBot", 30, { chatId: "-10099", chatType: "group" });

    assert.equal(mock.method("sendMessage").length, 0);
    assert.equal(mock.method("forwardMessage").length, 0);
    assert.equal(mock.method("copyMessage").length, 0);
  } finally {
    mock.restore();
  }
});
test("the announcement falls back to copyMessage when forwarding is blocked", async () => {
  mock = installTelegramFetchMock({
    fail: (method) => (method === "forwardMessage" ? "message can't be forwarded" : undefined),
  });
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/start", 23, { userId: "9002", chatId: "9002" });

    const copy = mock.method("copyMessage").at(-1);
    assert.ok(copy, "expected a copy fallback");
    assert.equal(copy.payload.chat_id, "9002");
    assert.equal(copy.payload.from_chat_id, "@MikuNaNChannel");
    assert.equal(copy.payload.message_id, 8);
    assert.ok(lastSubmissionEntry(), "expected a submission entry after the copied announcement");
  } finally {
    mock.restore();
  }
});

test("the admin sees why the announcement could not be forwarded", async () => {
  mock = installTelegramFetchMock({
    fail: (method) => {
      if (method === "forwardMessage") return "Bad Request: message can't be forwarded";
      if (method === "copyMessage") return "Bad Request: chat not found";
      return undefined;
    },
  });
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/start", 26);

    const send = mock.method("sendMessage").find((call) =>
      !call.payload.reply_markup && /MikuNaNChannel\/8/.test(call.payload.text)
    );
    assert.match(send.payload.text, /MikuNaNChannel\/8/);
    assert.match(send.payload.text, /公告自动转发未成功，已提供公告链接/);
    assert.doesNotMatch(send.payload.text, /message can't be forwarded|chat not found|Bad Request/);
    assert.ok(
      mock.method("sendMessage").some((call) => /需要提交图标？点击下方按钮/.test(String(call.payload.text || ""))),
      "expected /start to keep its submission CTA after the forward failure",
    );
    const audit = env.DB.auditLogs.find((entry) => entry.action === "telegram-announcement-failed");
    assert.ok(audit, "expected the failure to be recorded");
    assert.match(audit.detailsJson, /chat not found/);
  } finally {
    mock.restore();
  }
});

test("ordinary users do not see announcement diagnostics", async () => {
  mock = installTelegramFetchMock({
    fail: (method) => {
      if (method === "forwardMessage") return "Bad Request: message can't be forwarded";
      if (method === "copyMessage") return "Bad Request: chat not found";
      return undefined;
    },
  });
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/start", 27, { userId: "9003", chatId: "9003" });

    const send = mock.method("sendMessage").find((call) =>
      !call.payload.reply_markup && /MikuNaNChannel\/8/.test(call.payload.text)
    );
    assert.ok(send, "expected the announcement link fallback");
    assert.match(send.payload.text, /MikuNaNChannel\/8/);
    assert.doesNotMatch(send.payload.text, /公告转发失败|chat not found|message can't be forwarded/);
    assert.ok(lastSubmissionEntry(), "expected a submission entry after the link fallback");
  } finally {
    mock.restore();
  }
});

test("a failed submission entry stays best-effort and is recorded", async () => {
  mock = installTelegramFetchMock({
    fail: (method, payload) => (
      method === "sendMessage" && payload.reply_markup ? "Bad Request: inline keyboard URL is invalid" : undefined
    ),
  });
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    const response = await message(secret, env, "/start", 27, { userId: "9005", chatId: "9005" });

    assert.equal(response.status, 200);
    const audit = env.DB.auditLogs.find((entry) => entry.action === "telegram-submit-entry-failed");
    assert.ok(audit, "expected the entry failure to be recorded");
    assert.match(audit.detailsJson, /inline keyboard URL is invalid/);
    const fallback = mock.method("sendMessage").find((call) =>
      !call.payload.reply_markup && /t\.me\/emby_icons_bot\/submit\?startapp=channel8/.test(call.payload.text)
    );
    assert.ok(fallback, "a rejected inline keyboard must be followed by a plain link reply");
  } finally {
    mock.restore();
  }
});

test("a failed menu button does not block saving Telegram settings", async () => {
  mock = installTelegramFetchMock({
    fail: (method) => (method === "setChatMenuButton" ? "Bad Request: menu button URL is invalid" : undefined),
  });
  try {
    const env = createEnvironment({ icons: [] });
    const response = await handleAdminTelegramSettings(
      new Request("https://example.com/api/admin/telegram", {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled: true, chatId: CHAT_ID, botToken: BOT_TOKEN }),
      }),
      env,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.webhookConfigured, true);
    assert.equal(body.menuConfigured, false);
    assert.match(body.warning, /菜单按钮设置失败/);
    const audit = env.DB.auditLogs.find((entry) => entry.action === "telegram-menu-failed");
    assert.ok(audit, "expected the menu failure to be recorded");
  } finally {
    mock.restore();
  }
});

test("a failed command menu does not block saving Telegram settings", async () => {
  mock = installTelegramFetchMock({
    fail: (method) => (method === "setMyCommands" ? "Bad Request: command menu is invalid" : undefined),
  });
  try {
    const env = createEnvironment({ icons: [] });
    const response = await handleAdminTelegramSettings(
      new Request("https://example.com/api/admin/telegram", {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled: true, chatId: CHAT_ID, botToken: BOT_TOKEN }),
      }),
      env,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.webhookConfigured, true);
    assert.equal(body.menuConfigured, true);
    assert.equal(body.commandsConfigured, false);
    assert.match(body.warning, /命令菜单设置失败/);
    const audit = env.DB.auditLogs.find((entry) => entry.action === "telegram-commands-failed");
    assert.ok(audit, "expected the command menu failure to be recorded");
  } finally {
    mock.restore();
  }
});

test("disabling notifications keeps the webhook and command menus registered", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    await configureTelegram(env);
    const response = await handleAdminTelegramSettings(
      new Request("https://example.com/api/admin/telegram", {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled: false }),
      }),
      env,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.webhookConfigured, true);
    assert.equal(mock.method("deleteWebhook").length, 0);
    assert.equal(mock.method("setWebhook").length, 2, "saving should keep the webhook in place");
    assert.equal(mock.method("setChatMenuButton").at(-1).payload.menu_button.type, "commands");
    assert.equal(mock.method("setMyCommands").length, 4, "public and reviewer menus remain registered");
    assert.equal(mock.method("deleteMyCommands").length, 0);
  } finally {
    mock.restore();
  }
});

test("disabling the Bot removes its webhook, commands, and menu button", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const sendCallsBefore = mock.method("sendPhoto").length;

    const response = await handleAdminTelegramSettings(
      new Request("https://example.com/api/admin/telegram", {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled: true, botDisabled: true }),
      }),
      env,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.botDisabled, true);
    assert.equal(body.webhookDeleted, true);
    assert.equal(body.commandsDeleted, true);
    assert.equal(body.menuReset, true);
    assert.deepEqual(mock.method("deleteWebhook").at(-1).payload, { drop_pending_updates: true });
    assert.equal(mock.method("deleteMyCommands").length, 2);
    assert.deepEqual(
      mock.method("setChatMenuButton").at(-1).payload.menu_button,
      { type: "default" },
    );
    assert.equal(mock.method("setWebhook").length, 1, "saving the disabled state must not restore the webhook");
    assert.equal(await env.EMBY_ICONS.get("settings/telegram/commands-version"), null);

    const blocked = await message(secret, env, "/start");
    assert.equal(blocked.status, 404);

    const notified = await notifyNewSubmission(
      env,
      { id: "disabled-bot", name: "DisabledBot", url: "https://example.com/disabled.png", note: "" },
      "https://example.com",
    );
    assert.equal(notified, false);
    assert.equal(mock.method("sendPhoto").length, sendCallsBefore);

    const sync = await handleAdminTelegramSettings(
      new Request("https://example.com/api/admin/telegram", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ action: "sync" }),
      }),
      env,
    );
    const syncBody = await sync.json();
    assert.equal(sync.status, 409);
    assert.equal(syncBody.code, "TELEGRAM_BOT_DISABLED");
  } finally {
    mock.restore();
  }
});

test("re-enabling the Bot restores its webhook and command menus", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    await handleAdminTelegramSettings(
      new Request("https://example.com/api/admin/telegram", {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled: true, botDisabled: true }),
      }),
      env,
    );

    const response = await handleAdminTelegramSettings(
      new Request("https://example.com/api/admin/telegram", {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled: true, botDisabled: false }),
      }),
      env,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.botDisabled, false);
    assert.equal(body.webhookConfigured, true);
    assert.equal(body.commandsConfigured, true);
    assert.equal(mock.method("setWebhook").length, 2);
    assert.deepEqual(mock.method("setChatMenuButton").at(-1).payload.menu_button, { type: "commands" });
    assert.equal(mock.method("setMyCommands").length, 4);

    const update = await message(secret, env, "/start");
    assert.equal(update.status, 200);
  } finally {
    mock.restore();
  }
});

test("a webhook updates the persistent menu button after a command version change", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const menuCallsBefore = mock.method("setChatMenuButton").length;
    const commandCallsBefore = mock.method("setMyCommands").length;

    await env.EMBY_ICONS.put("settings/telegram/commands-version", "outdated");
    await message(secret, env, "/start", 32, { userId: "9009", chatId: "9009" });

    const menuButton = mock.method("setChatMenuButton").at(-1);
    assert.equal(mock.method("setChatMenuButton").length, menuCallsBefore + 1);
    assert.deepEqual(menuButton.payload.menu_button, { type: "commands" });
    assert.equal(mock.method("setMyCommands").length, commandCallsBefore + 2);
    assert.notEqual(
      await env.EMBY_ICONS.get("settings/telegram/commands-version"),
      "outdated",
    );
  } finally {
    mock.restore();
  }
});

test("admin Telegram route exposes the webhook sync POST handler", () => {
  assert.equal(typeof telegramAdminRoute.onRequestPost, "function");
  assert.equal(typeof telegramAdminRoute.onRequestGet, "function");
  assert.equal(typeof telegramAdminRoute.onRequestPut, "function");
});

test("admin webhook sync reports a redacted diagnostic without exposing secrets", async () => {
  mock = installTelegramFetchMock({
    webhookInfo: () => ({
      url: mock.method("setWebhook").at(-1).payload.url,
      pending_update_count: 2,
      last_error_message: "Conflict: terminated by other getUpdates request",
    }),
  });
  try {
    const env = createEnvironment({ icons: [] });
    await configureTelegram(env);

    const response = await handleAdminTelegramSettings(
      new Request("https://example.com/api/admin/telegram", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ action: "sync" }),
      }),
      env,
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.synced, true);
    assert.equal(body.webhookConfigured, true);
    assert.equal(body.menuConfigured, true);
    assert.equal(body.commandsConfigured, true);
    assert.equal(body.webhook.matchesExpected, true);
    assert.equal(body.webhook.pendingUpdateCount, 2);
    assert.match(body.webhook.lastErrorMessage, /terminated by other getUpdates/);
    assert.match(body.webhook.url, /\/api\/telegram\/webhook\/\*\*\*$/);
    const webhookSecret = String(mock.method("setWebhook").at(-1).payload.url).split("/").at(-1);
    assert.ok(webhookSecret);
    assert.doesNotMatch(serialized, /TEST-TOKEN/);
    assert.equal(serialized.includes(webhookSecret), false, "the webhook secret must be redacted");
    assert.equal(mock.method("setWebhook").length, 2);
    assert.equal(mock.method("getWebhookInfo").length, 1);
  } finally {
    mock.restore();
  }
});

test("ordinary messages from other chats stay ignored", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "hello", 24, { userId: "9003", chatId: "9003" });

    assert.equal(mock.method("forwardMessage").length, 0);
    assert.equal(mock.method("sendMessage").length, 0);
  } finally {
    mock.restore();
  }
});

test("unrelated group commands do not forward the announcement", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/help", 25, { userId: "9004", chatId: "-10099", chatType: "group" });

    assert.equal(mock.method("forwardMessage").length, 0);
    assert.equal(mock.method("copyMessage").length, 0);
  } finally {
    mock.restore();
  }
});

test("the /queue command lists pending submissions with jump buttons", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const first = await createSubmission(env, "QueueA", "https://example.com/a.png");
    const second = await createSubmission(env, "QueueB", "https://example.com/b.png");

    await message(secret, env, "/queue");

    const send = mock.method("sendMessage").at(-1);
    assert.equal(send.payload.parse_mode, "HTML");
    assert.match(send.payload.text, /待审核队列/);
    assert.match(send.payload.text, /QueueA/);
    assert.match(send.payload.text, /QueueB/);
    const buttons = send.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(buttons.includes(`view:${first}`));
    assert.ok(buttons.includes(`view:${second}`));
  } finally {
    mock.restore();
  }
});

test("the /queue command reports an empty queue", async () => {
  mock = installTelegramFetchMock();
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);

    await message(secret, env, "/queue");

    assert.match(mock.method("sendMessage").at(-1).payload.text, /没有待审核的提交/);
  } finally {
    mock.restore();
  }
});

telegramTest("a name duplicated inside the queue is flagged with rename suggestions", async ({ env, secret }) => {
  const first = await createSubmission(env, "test", "https://example.com/a.png");
  const second = await createSubmission(env, "test", "https://example.com/b.png");

  // The newer duplicate lands on a conflict card straight away.
  const card = lastCardSend();
  assert.match(cardText(card), /队列内名称重复/);
  const buttons = card.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(buttons.includes(`rename:${second}:0`), "expected a one-tap rename suggestion");
  assert.ok(buttons.includes(`rename-manual:${second}`));
  assert.ok(buttons.includes(`reject:${second}`));
  assert.ok(!buttons.includes(`replace:${second}`), "nothing is published to replace yet");
  assert.ok(env.__kv.has(`settings/telegram/conflict/${second}`));

  // The one-tap suggestion publishes the duplicate under a free name.
  await callback(secret, env, `rename:${second}:0`);
  assert.equal(env.DB.submissions.get(second).name, "test01");
  assert.equal(env.DB.submissions.get(second).status, "approved");
  assert.deepEqual(readKv(env).icons.map((icon) => icon.name), ["test01"]);
  // The first submission is untouched and still waiting.
  assert.equal(env.DB.submissions.get(first).status, "pending");
  assert.equal(env.DB.submissions.get(first).name, "test");
});

telegramTest("the /queue listing marks names shared by pending submissions", async ({ env, secret }) => {
  await createSubmission(env, "Dup", "https://example.com/a.png");
  await createSubmission(env, "Dup", "https://example.com/b.png");
  await createSubmission(env, "Solo", "https://example.com/c.png");

  await message(secret, env, "/queue");

  const send = mock.method("sendMessage").at(-1);
  const marked = send.payload.text.split("\n").filter((line) => line.includes("重名"));
  assert.equal(marked.length, 2, "both duplicate rows should be marked");
  assert.match(send.payload.text, /Solo/);
  assert.ok(!send.payload.text.includes("Solo</b> ⚠️"), "unique names stay unmarked");
});

telegramTest("editing and publishing rewrites the name, URL and description", async ({ env, secret }) => {
  const id = await createSubmission(env, "EditMe", "https://example.com/original.png");

  await callback(secret, env, `edit:${id}`);
  assert.equal(pendingState(env).action, "edit");
  assert.match(lastReviewEdit().payload.text, /修改内容/);

  await message(secret, env, "名称：Edited\nURL：https://example.com/edited.png\n说明：新的说明");

  assert.deepEqual(readKv(env).icons, [{ name: "Edited", url: "https://example.com/edited.png" }]);
  const row = env.DB.submissions.get(id);
  assert.equal(row.status, "approved");
  assert.equal(row.name, "Edited");
  assert.equal(row.url, "https://example.com/edited.png");
  assert.equal(row.note, "新的说明");
  assert.equal(pendingState(env), null);
});

telegramTest("editing rejects a non-HTTPS URL without publishing", async ({ env, secret }) => {
  const id = await createSubmission(env, "EditBad", "https://example.com/original.png");

  await callback(secret, env, `edit:${id}`);
  await message(secret, env, "名称：EditBad\nURL：http://example.com/insecure.png");

  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.equal(readKv(env).icons.length, 0);
  assert.ok(pendingState(env), "the edit flow stays open for another try");
});

telegramTest("publishing offers the next pending submission", async ({ env, secret }) => {
  const first = await createSubmission(env, "FirstPending", "https://example.com/1.png");
  const second = await createSubmission(env, "SecondPending", "https://example.com/2.png");

  await callback(secret, env, `approve:${first}`);
  await callback(secret, env, buttonData("approve-confirm"));

  const nextButton = buttonData("view");
  assert.ok(nextButton, "expected a next-pending button after publishing");
  assert.equal(nextButton, `view:${second}`);

  const sendsBefore = mock.method("sendPhoto").length + mock.method("sendMessage").length;
  await callback(secret, env, nextButton);
  assert.equal(mock.method("sendPhoto").length + mock.method("sendMessage").length, sendsBefore,
    "jumping to the next submission must not send a new card");
  const refreshed = lastReviewEdit();
  assert.match(refreshed.payload.text, /SecondPending/);
  assert.ok(refreshed.payload.reply_markup.inline_keyboard.flat()
    .some((button) => button.callback_data?.startsWith("approve:")), "refreshed card should carry review buttons");
});

telegramTest("jumping to the next submission swaps the photo card in place", async ({ env, secret }) => {
  const first = await createSubmission(env, "PhotoFirst", "https://example.com/1.png");
  const second = await createSubmission(env, "PhotoSecond", "https://example.com/2.png");

  await callback(secret, env, `approve:${first}`);
  await callback(secret, env, buttonData("approve-confirm"));

  const nextButton = buttonData("view");
  assert.equal(nextButton, `view:${second}`);

  const sendsBefore = mock.method("sendPhoto").length + mock.method("sendMessage").length;
  // Pretend the live card is the photo message Telegram rendered.
  await callback(secret, env, nextButton, "photo-next", { photo: [{ file_id: "first-icon" }] });

  assert.equal(mock.method("sendPhoto").length + mock.method("sendMessage").length, sendsBefore,
    "a photo card must be refreshed, not resent");
  const media = mock.method("editMessageMedia").at(-1);
  assert.ok(media, "photo card should swap media in place");
  assert.equal(media.payload.media.media, "https://example.com/2.png");
  assert.match(media.payload.media.caption, /PhotoSecond/);
  assert.ok(media.payload.reply_markup.inline_keyboard.flat()
    .some((button) => button.callback_data?.startsWith("approve:")));
});

telegramTest("callback toasts match the action that was triggered", async ({ env, secret }) => {
  const id = await createSubmission(env, "ToastCopy", "https://example.com/toast.png");

  await callback(secret, env, `reject:${id}`, "open");
  assert.match(mock.method("answerCallbackQuery").at(-1).payload.text, /请回复拒绝原因/);

  await callback(secret, env, buttonData("cancel"), "cancel");
  assert.match(mock.method("answerCallbackQuery").at(-1).payload.text, /已取消操作/);
});

telegramTest("Telegram initData verification accepts fresh signed data and rejects tampering or stale data", async ({ env }) => {
  const user = { id: 9101, username: "signed_user", first_name: "Signed" };
  const valid = makeTelegramInitData(BOT_TOKEN, user);
  const identity = await verifyTelegramInitData(env, valid);
  assert.equal(identity.id, user.id);
  assert.equal(identity.username, user.username);

  const tampered = valid.replace("signed_user", "changed_user");
  assert.equal(await verifyTelegramInitData(env, tampered), null);
  assert.equal(
    await verifyTelegramInitData(env, makeTelegramInitData(BOT_TOKEN, user, Math.floor(Date.now() / 1000) - 172800)),
    null,
  );
  assert.equal(
    await verifyTelegramInitData(env, makeTelegramInitData(BOT_TOKEN, user, Math.floor(Date.now() / 1000) + 120)),
    null,
  );
  assert.equal(
    await verifyTelegramInitData(env, makeTelegramInitData("999999:WRONG-TOKEN", user)),
    null,
  );
});

telegramTest("Mini App submissions bind Telegram identity and reject invalid initData without downgrading", async ({ env }) => {
  const initData = makeTelegramInitData(BOT_TOKEN, { id: 9102, username: "bound_user", first_name: "Bound" });
  const response = await handleSubmissionCreate(
    new Request("https://example.com/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": initData },
      body: JSON.stringify({ name: "BoundIcon", url: "https://example.com/bound.png" }),
    }),
    env,
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.telegramBound, true);
  const row = env.DB.submissions.get(body.submission.id);
  assert.equal(row.telegram_user_id, 9102);
  assert.equal(row.telegram_username, "bound_user");

  const before = env.DB.submissions.size;
  const invalid = makeTelegramInitData("999999:WRONG-TOKEN", { id: 9103, username: "forged" });
  const rejected = await handleSubmissionCreate(
    new Request("https://example.com/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": invalid },
      body: JSON.stringify({ name: "ForgedIcon", url: "https://example.com/forged.png" }),
    }),
    env,
  );
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).code, "TELEGRAM_AUTH_INVALID");
  assert.equal(env.DB.submissions.size, before);

  // A valid access token must not silently override forged or expired initData.
  const tokenPlusInvalidIdentity = await handleSubmissionItem(
    new Request("https://example.com/api/submissions/" + body.submission.id, {
      headers: {
        "X-Submission-Token": body.accessToken,
        "X-Telegram-Init-Data": invalid,
      },
    }),
    env,
    body.submission.id,
  );
  assert.equal(tokenPlusInvalidIdentity.status, 401);
  assert.equal((await tokenPlusInvalidIdentity.json()).code, "TELEGRAM_AUTH_INVALID");
});

telegramTest("Telegram identity grants record ownership only to the same user", async ({ env }) => {
  const owner = makeTelegramInitData(BOT_TOKEN, { id: 9104, username: "owner_user" });
  const other = makeTelegramInitData(BOT_TOKEN, { id: 9105, username: "other_user" });
  const id = await createSubmission(env, "OwnedIcon", "https://example.com/owned.png", { initData: owner });

  const allowed = await handleSubmissionItem(
    new Request("https://example.com/api/submissions/" + id, {
      headers: { "X-Telegram-Init-Data": owner },
    }),
    env,
    id,
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).submission.name, "OwnedIcon");

  const denied = await handleSubmissionItem(
    new Request("https://example.com/api/submissions/" + id, {
      headers: { "X-Telegram-Init-Data": other },
    }),
    env,
    id,
  );
  assert.equal(denied.status, 403);
});

telegramTest("/my and the Telegram submission list expose only the current users records", async ({ env, secret }) => {
  const alice = makeTelegramInitData(BOT_TOKEN, { id: 9106, username: "alice" });
  const bob = makeTelegramInitData(BOT_TOKEN, { id: 9107, username: "bob" });
  const aliceId = await createSubmission(env, "AliceIcon", "https://example.com/alice.png", { initData: alice });
  await createSubmission(env, "BobIcon", "https://example.com/bob.png", { initData: bob });

  await message(secret, env, "/my", 31, { userId: "9106", chatId: "9106" });
  const entry = mock.method("sendMessage").at(-1);
  assert.equal(entry.payload.chat_id, "9106");
  assert.equal(entry.payload.reply_markup.inline_keyboard[0][0].text, "📋 打开我的提交");
  assert.equal(entry.payload.reply_markup.inline_keyboard[0][0].web_app.url, "https://example.com/submit?startapp=my");

  const response = await handleMySubmissionList(
    new Request("https://example.com/api/my/submissions", {
      headers: { "X-Telegram-Init-Data": alice },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.submissions.map((item) => item.id), [aliceId]);
  assert.equal(body.submissions[0].name, "AliceIcon");
});

telegramTest("approving a bound submission sends a private result notification", async ({ env }) => {
  const initData = makeTelegramInitData(BOT_TOKEN, { id: 9108, username: "approved_user" });
  const id = await createSubmission(env, "ApprovedIcon", "https://example.com/approved.png", { initData });
  const response = await decide(env, id, { action: "approve" });
  assert.equal(response.status, 200);

  const sent = mock.method("sendMessage").find((call) => String(call.payload.chat_id) === "9108");
  assert.ok(sent, "expected a private result notification");
  assert.match(sent.payload.text, /已通过审核/);
  assert.match(sent.payload.text, /ApprovedIcon/);
  assert.equal(sent.payload.reply_markup, undefined);
  assert.equal(typeof env.DB.submissions.get(id).result_notified_at, "number");
});

telegramTest("rejection notification includes the reason and a resubmit Mini App button", async ({ env }) => {
  const initData = makeTelegramInitData(BOT_TOKEN, { id: 9109, username: "rejected_user" });
  const id = await createSubmission(env, "RejectedIcon", "https://example.com/rejected.png", { initData });
  const response = await decide(env, id, { action: "reject", note: "图片无法访问" });
  assert.equal(response.status, 200);

  const sent = mock.method("sendMessage").find((call) => String(call.payload.chat_id) === "9109");
  assert.ok(sent, "expected a private rejection notification");
  assert.match(sent.payload.text, /未通过审核/);
  assert.match(sent.payload.text, /图片无法访问/);
  const button = sent.payload.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, "🔁 重新提交");
  assert.equal(
    button.web_app.url,
    "https://example.com/submit?startapp=resubmit_" + encodeURIComponent(id),
  );
});

test("a failed result notification does not roll back the review and can be retried once", async () => {
  let failUserNotification = true;
  mock = installTelegramFetchMock({
    fail: (method, payload) => (
      method === "sendMessage" && String(payload.chat_id) === "9110" && failUserNotification
        ? "Forbidden: bot was blocked by the user"
        : undefined
    ),
  });
  try {
    const env = createEnvironment({ icons: [] });
    const secret = await configureTelegram(env);
    const initData = makeTelegramInitData(BOT_TOKEN, { id: 9110, username: "retry_user" });
    const id = await createSubmission(env, "RetryNotification", "https://example.com/retry.png", { initData });

    const response = await decide(env, id, { action: "reject", note: "格式不正确" });
    assert.equal(response.status, 200);
    assert.equal(env.DB.submissions.get(id).status, "rejected");
    assert.equal(env.DB.submissions.get(id).result_notified_at, null);
    const failure = env.DB.auditLogs.find((entry) => entry.action === "submission-result-notification-failed");
    assert.ok(failure, "expected the notification failure to be audited");

    failUserNotification = false;
    assert.equal(await notifySubmissionResult(env, id), true);
    assert.equal(typeof env.DB.submissions.get(id).result_notified_at, "number");
    assert.equal(await notifySubmissionResult(env, id), false, "the claimed result must not be sent twice");
    const delivered = mock.method("sendMessage").filter((call) => String(call.payload.chat_id) === "9110" && /未通过审核/.test(call.payload.text));
    assert.equal(delivered.length, 2, "one failed attempt and one successful retry");
  } finally {
    mock.restore();
  }
});

telegramTest("an audit failure during result notification cannot change the review outcome", async ({ env }) => {
  const initData = makeTelegramInitData(BOT_TOKEN, { id: 9111, username: "audit_user" });
  const id = await createSubmission(env, "AuditSafe", "https://example.com/audit.png", { initData });
  env.DB.auditFailures = 10;

  const response = await decide(env, id, { action: "reject", note: "测试审计失败" });
  assert.equal(response.status, 200);
  assert.equal(env.DB.submissions.get(id).status, "rejected");
  assert.equal(env.DB.submissions.get(id).reviewer_note, "测试审计失败");
  const sent = mock.method("sendMessage").find((call) => String(call.payload.chat_id) === "9111");
  assert.ok(sent, "the notification should still be attempted");
  assert.match(sent.payload.text, /测试审计失败/);
});
