import { handleAdminOptions, handleGet, handlePut } from "../_shared/icons.js";

export function onRequestGet({ request, env }) {
  return handleGet(request, env);
}

export function onRequestPut({ request, env }) {
  return handlePut(request, env);
}

export function onRequestOptions({ request, env }) {
  return handleAdminOptions(request, env);
}
