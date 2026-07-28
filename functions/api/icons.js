import { handleGet, handleOptions, handlePut } from "../_shared/icons.js";

export function onRequestGet({ request, env }) {
  return handleGet(request, env);
}

export function onRequestPut({ request, env }) {
  return handlePut(request, env);
}

export function onRequestOptions() {
  return handleOptions();
}
