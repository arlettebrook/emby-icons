import { handleAdminVersionItem, handleVersionOptions } from "../../../_shared/versions.js";

export function onRequestGet({ request, env, params }) {
  return handleAdminVersionItem(request, env, params.id);
}

export function onRequestPost({ request, env, params }) {
  return handleAdminVersionItem(request, env, params.id);
}

export function onRequestOptions() {
  return handleVersionOptions();
}