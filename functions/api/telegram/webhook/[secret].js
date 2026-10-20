import { handleTelegramWebhook } from "../../../_shared/telegram.js";

export function onRequestPost({ request, env, params, waitUntil }) {
  return handleTelegramWebhook(request, env, params.secret, waitUntil);
}
