import {
  handleAdminRemoteJsonUrlCollection,
  handleRemoteJsonUrlOptions,
} from "../../_shared/remote-json-urls.js";

export function onRequestGet({ request, env }) {
  return handleAdminRemoteJsonUrlCollection(request, env);
}

export function onRequestPost({ request, env }) {
  return handleAdminRemoteJsonUrlCollection(request, env);
}

export function onRequestOptions({ request }) {
  return handleRemoteJsonUrlOptions(request);
}
