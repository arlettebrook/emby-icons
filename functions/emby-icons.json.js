import { handleGet, handleOptions } from "./_shared/icons.js";

export function onRequestGet({ request, env }) {
  return handleGet(request, env, "public, max-age=60, stale-while-revalidate=300");
}

export function onRequestOptions() {
  return handleOptions();
}
