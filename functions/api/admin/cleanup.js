import {
  handleAdminCleanup,
  handleCleanupOptions,
} from "../../_shared/cleanup.js";

export function onRequestPost({ request, env }) {
  return handleAdminCleanup(request, env);
}

export function onRequestOptions({ request }) {
  return handleCleanupOptions(request);
}
