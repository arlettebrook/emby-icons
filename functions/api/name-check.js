import { handleNameCheck, handleOptions } from "../_shared/icons.js";

export function onRequestGet({ request, env }) {
  return handleNameCheck(request, env);
}

export function onRequestOptions() {
  return handleOptions();
}
