import {
  handleAdminRemoteJsonUrlItem,
  handleRemoteJsonUrlOptions,
} from "../../../_shared/remote-json-urls.js";

export function onRequestGet({ request, env, params }) {
  return handleAdminRemoteJsonUrlItem(request, env, params.id);
}

export function onRequestPut({ request, env, params }) {
  return handleAdminRemoteJsonUrlItem(request, env, params.id);
}

export function onRequestDelete({ request, env, params }) {
  return handleAdminRemoteJsonUrlItem(request, env, params.id);
}

export function onRequestOptions({ request }) {
  return handleRemoteJsonUrlOptions(request);
}
