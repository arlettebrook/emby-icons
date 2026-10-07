import assert from "node:assert/strict";
import test from "node:test";

import {
  handleAdminTelegramSettings,
  handleTelegramWebhook,
  notifyNewSubmission,
} from "../functions/_shared/telegram.js";
import { adminHeaders, createEnvironment, createSubmission, readKv } from "./helpers.js";

const CHAT_ID = "7328767184";
const BOT_TOKEN = "123456:TEST-TOKEN";

function installTelegramFetchMock() {
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
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
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

async function configureTelegram(env) {
  const response = await handleAdminTelegramSettings(
    new Request("https://example.com/api/admin/telegram", {
      method: "PUT",
      headers: adminHeaders(),
      body: JSON.stringify({ enabled: true, chatId: CHAT_ID, botToken: BOT_TOKEN }),
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

function message(secret, env, text, messageId = 11) {
  return handleTelegramWebhook(
    webhookRequest(secret, {
      message: { chat: { id: CHAT_ID }, message_id: messageId, text },
    }),
    env,
    secret,
  );
}

function callback(secret, env, data, callbackId = "cb-1") {
  return handleTelegramWebhook(
    webhookRequest(secret, {
      callback_query: {
        id: callbackId,
        data,
        message: { chat: { id: CHAT_ID }, message_id: 10, text: "original" },
      },
    }),
    env,
    secret,
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

    const edit = mock.method("editMessageText").at(-1);
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
    assert.match(answer.payload.text, /OkEmby02/);
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
    assert.ok(env.__kv.has(`settings/telegram/rename/${CHAT_ID}`));

    await message(secret, env, "OkEmbyCustom");
    const icons = readKv(env).icons;
    assert.deepEqual(icons.map((icon) => icon.name), ["OkEmby", "OkEmbyCustom"]);
    assert.equal(env.DB.submissions.get(id).status, "approved");
    assert.equal(env.DB.submissions.get(id).name, "OkEmbyCustom");
    assert.ok(!env.__kv.has(`settings/telegram/rename/${CHAT_ID}`), "rename state should be cleared");
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
    assert.ok(env.__kv.has(`settings/telegram/rename/${CHAT_ID}`), "rename flow should stay open");
    const edit = mock.method("editMessageText").at(-1);
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

    assert.ok(!env.__kv.has(`settings/telegram/rename/${CHAT_ID}`));
    assert.equal(env.DB.submissions.get(id).status, "pending");
    const edit = mock.method("editMessageText").at(-1);
    assert.match(edit.payload.text, /取消改名/);
    const buttons = edit.payload.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(buttons.includes(`approve:${id}`));
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