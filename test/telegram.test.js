import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAdminTelegramSettings,
  handleTelegramWebhook,
  notifyNewSubmission,
} from "../functions/_shared/telegram.js";
import { adminHeaders, createEnvironment, createSubmission, readKv } from "./helpers.js";

const CHAT_ID = "7328767184";
const USER_ID = "1001";
const BOT_TOKEN = "123456:TEST-TOKEN";

function installTelegramFetchMock({ fail } = {}) {
  let nextMessageId = 100;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
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
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++nextMessageId } }), {
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
  const setWebhook = mock.calls.find((call) => call.method === "setWebhook");
  assert.ok(setWebhook, "expected a setWebhook call");
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
  return mock.method("editMessageText").filter((call) => call.payload.message_id === messageId).at(-1);
}

function buttonData(action, messageId = 10) {
  return lastReviewEdit(messageId)?.payload.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data.startsWith(action + ":"))?.callback_data;
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
  const { userId = USER_ID, chatId = CHAT_ID, messageId = 10, text = "original" } = options;
  return handleTelegramWebhook(
    webhookRequest(secret, {
      callback_query: {
        id: callbackId, from: { id: userId }, data,
        message: { chat: { id: chatId }, message_id: messageId, text },
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

    const send = mock.method("sendMessage").at(-1);
    assert.ok(send, "expected a sendMessage call");
    assert.match(send.payload.text, /名称冲突/);
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
    assert.deepEqual(icons.map((icon) => icon.name), ["OkEmby", "OkEmby02"]);
    assert.equal(env.DB.submissions.get(id).status, "approved");
    assert.equal(env.DB.submissions.get(id).name, "OkEmby02");
    const answer = mock.method("answerCallbackQuery").at(-1);
    assert.match(answer.payload.text, /正在处理/);
    assert.match(lastReviewEdit().payload.text, /已改名为「OkEmby02」/);
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
    const buttons = mock.method("sendMessage").at(-1).payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
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

    const prompt = mock.method("sendMessage").at(-1).payload.text;
    assert.match(prompt, /请直接回复新的图标名称/);
    assert.match(prompt, /当前名称：MyEmbyIcon/);
    assert.match(prompt, /\/cancel/);
    assert.doesNotMatch(prompt, /OkEmby02/);

    const edit = lastReviewEdit();
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

    const prompt = mock.method("sendMessage").at(-1).payload.text;
    assert.match(prompt, /当前名称：OkEmby/);
    assert.match(prompt, /冲突可用：OkEmby\d{2}/);
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
    const buttons = mock.method("sendMessage").at(-1).payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
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
  const prompt = mock.method("sendMessage").at(-1).payload;
  assert.equal(prompt.reply_markup.force_reply, true);
  assert.equal(prompt.reply_markup.selective, true);
  assert.equal(prompt.entities[0].user.id, Number(USER_ID));
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

telegramTest("group chatter, another reviewer and stale replies cannot become rejection reasons", async ({ env, secret }) => {
  const chatId = "-100123";
  const id = await createSubmission(env, "GroupReview", "https://example.com/group.png");
  await callback(secret, env, `reject:${id}`, "group", { chatId });
  const state = pendingState(env, USER_ID, chatId);
  const options = { chatId, chatType: "supergroup" };
  await message(secret, env, "今天讨论的事情", 20, options);
  await message(secret, env, "其他人的消息", 21, { ...options, userId: "1002", replyTo: state.promptMessageId });
  await message(secret, env, "旧回复", 22, { ...options, replyTo: state.promptMessageId - 1 });
  assert.equal(env.DB.submissions.get(id).status, "pending");
  await message(secret, env, "确实无法访问", 23, { ...options, replyTo: state.promptMessageId });
  assert.equal(env.DB.submissions.get(id).reviewer_note, "确实无法访问");
}, { chatId: "-100123" });

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

telegramTest("switching submissions restores the old card and ignores replies to its prompt", async ({ env, secret }) => {
  const a = await createSubmission(env, "OldFlow", "https://example.com/a.png");
  const b = await createSubmission(env, "NewFlow", "https://example.com/b.png");
  await callback(secret, env, `rename-manual:${a}`);
  const oldPrompt = pendingState(env).promptMessageId;
  await callback(secret, env, `reject:${b}`, "b", { messageId: 20 });
  assert.equal(pendingState(env).id, b);
  assert.match(lastReviewEdit(10).payload.text, /已切换/);
  assert.ok(buttonData("approve", 10));
  await message(secret, env, "不应成为拒绝原因", 21, { replyTo: oldPrompt });
  assert.equal(env.DB.submissions.get(a).status, "pending");
  assert.equal(env.DB.submissions.get(b).status, "pending");
  await message(secret, env, "正确拒绝原因", 22, { replyTo: pendingState(env).promptMessageId });
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

telegramTest("approving another card does not clear an unrelated pending input", async ({ env, secret }) => {
  const a = await createSubmission(env, "StillWaiting", "https://example.com/a.png");
  const b = await createSubmission(env, "ApprovedNow", "https://example.com/b.png");
  await callback(secret, env, `rename-manual:${a}`);
  await callback(secret, env, `approve:${b}`, "b", { messageId: 20 });
  assert.equal(pendingState(env).id, a);
  await message(secret, env, "StillWaitingRenamed");
  assert.equal(env.DB.submissions.get(a).status, "approved");
  assert.equal(env.DB.submissions.get(b).status, "approved");
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
    for (const button of call.payload.reply_markup?.inline_keyboard?.flat() || []) {
      assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
    }
  }
  assert.equal(row.reviewer_note.length, 1000);
});

telegramTest("invalid names keep the flow open and send a fresh targeted reply prompt", async ({ env, secret }) => {
  const id = await createSubmission(env, "Validation", "https://example.com/validation.png");
  await callback(secret, env, `rename-manual:${id}`);
  const previous = pendingState(env).promptMessageId;
  await message(secret, env, "a".repeat(121));
  const current = pendingState(env).promptMessageId;
  assert.notEqual(current, previous);
  assert.match(mock.method("sendMessage").at(-1).payload.text, /1-120/);
  await message(secret, env, "ValidName", 22, { replyTo: current });
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
  assert.equal(env.DB.submissions.get(id).status, "approved");
  assert.equal(mock.method("answerCallbackQuery").length, 1);
});

telegramTest("completed decisions fall back to a result message when the card cannot be edited", async ({ env, secret }) => {
  const id = await createSubmission(env, "MissingCard", "https://example.com/missing.png");
  await callback(secret, env, `approve:${id}`);
  assert.equal(env.DB.submissions.get(id).status, "approved");
  assert.match(mock.method("sendMessage").at(-1).payload.text, /已通过并发布/);
}, { mock: { fail: (method) => method === "editMessageText" ? "Bad Request: message to edit not found" : "" } });

telegramTest("a failed prompt send restores the card without leaving an invisible input session", async ({ env, secret }) => {
  const id = await createSubmission(env, "PromptFailure", "https://example.com/prompt.png");
  await callback(secret, env, `rename-manual:${id}`);
  assert.equal(pendingState(env), null);
  assert.equal(env.DB.submissions.get(id).status, "pending");
  assert.match(lastReviewEdit().payload.text, /输入提示发送失败/);
  assert.ok(buttonData("approve"));
}, { mock: { fail: (method) => method === "sendMessage" ? "Telegram unavailable" : "" } });

telegramTest("disabling Telegram makes an old authenticated webhook inert", async ({ env, secret }) => {
  const id = await createSubmission(env, "Disabled", "https://example.com/disabled.png");
  const config = JSON.parse(env.__kv.get("settings/telegram.json"));
  config.enabled = false;
  await env.EMBY_ICONS.put("settings/telegram.json", JSON.stringify(config));
  const response = await callback(secret, env, `approve:${id}`);
  assert.equal(response.status, 404);
  assert.equal(env.DB.submissions.get(id).status, "pending");
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
