import { handleGet, handleOptions } from "./_shared/icons.js";

export function onRequestGet({ request, env }) {
  return handleGet(request, env, "no-cache", { useGithubProxy: true });
}

export function onRequestOptions() {
  return handleOptions();
}
