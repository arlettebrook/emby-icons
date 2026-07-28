import { handleGet, handleOptions } from "./_shared/icons.js";

export function onRequestGet({ request, env }) {
  return handleGet(request, env, "no-cache");
}

export function onRequestOptions() {
  return handleOptions();
}
