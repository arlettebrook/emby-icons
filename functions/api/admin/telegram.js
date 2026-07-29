import {
  handleAdminTelegramSettings,
  handleTelegramOptions,
} from "../../_shared/telegram.js";

export function onRequestGet({ request, env }) {
  return handleAdminTelegramSettings(request, env);
}

export function onRequestPut({ request, env }) {
  return handleAdminTelegramSettings(request, env);
}

export function onRequestOptions({ request }) {
  return handleTelegramOptions(request);
}
