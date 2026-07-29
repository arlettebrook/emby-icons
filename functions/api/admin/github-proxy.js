import {
  handleAdminGithubProxySettings,
  handleGithubProxyOptions,
} from "../../_shared/github-proxy.js";

export function onRequestGet({ request, env }) {
  return handleAdminGithubProxySettings(request, env);
}

export function onRequestPut({ request, env }) {
  return handleAdminGithubProxySettings(request, env);
}

export function onRequestOptions({ request }) {
  return handleGithubProxyOptions(request);
}
