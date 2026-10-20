import { handleAdminVersionList, handleVersionOptions } from "../../_shared/versions.js";

export function onRequestGet({ request, env }) {
  return handleAdminVersionList(request, env);
}

export function onRequestOptions() {
  return handleVersionOptions();
}