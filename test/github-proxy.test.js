import assert from "node:assert/strict";
import test from "node:test";

import { handleGet } from "../functions/_shared/icons.js";
import {
  GITHUB_PROXY_SETTINGS_KEY,
  handleAdminGithubProxySettings,
} from "../functions/_shared/github-proxy.js";

const document = {
  name: "Emby Icons",
  description: "Test",
  icons: [
    { name: "Raw GitHub", url: "https://raw.githubusercontent.com/example/repo/main/icon.png" },
    { name: "HTTP GitHub", url: "http://raw.githubusercontent.com/example/repo/main/http.png" },
    { name: "Other", url: "https://example.com/icon.png" },
  ],
};

function createEnvironment(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    ADMIN_TOKEN: "secret-token",
    EMBY_ICONS: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => values.set(key, value),
    },
  };
}

test("public JSON applies the enabled proxy without changing KV or the raw API", async () => {
  const raw = `${JSON.stringify(document, null, 2)}\n`;
  const env = createEnvironment({ "emby-icons.json": raw });
  await env.EMBY_ICONS.put(GITHUB_PROXY_SETTINGS_KEY, JSON.stringify({ enabled: true, proxyUrl: "https://proxy.example/" }));

  const publicResponse = await handleGet(
    new Request("https://example.com/emby-icons.json"),
    env,
    "no-cache",
    { useGithubProxy: true },
  );
  const publicDocument = await publicResponse.json();
  assert.equal(publicDocument.icons[0].url, "https://proxy.example/https://raw.githubusercontent.com/example/repo/main/icon.png");
  assert.equal(publicDocument.icons[1].url, document.icons[1].url);
  assert.equal(publicDocument.icons[2].url, document.icons[2].url);

  const rawResponse = await handleGet(new Request("https://example.com/api/icons"), env);
  assert.deepEqual(await rawResponse.json(), document);
  assert.equal(await env.EMBY_ICONS.get("emby-icons.json"), raw);
});

test("admin can save and read GitHub proxy settings in a separate KV key", async () => {
  const env = createEnvironment();
  const request = (method, body) => new Request("https://example.com/api/admin/github-proxy", {
    method,
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const saved = await handleAdminGithubProxySettings(request("PUT", {
    enabled: true,
    proxyUrl: "https://proxy.example/base/",
  }), env);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { enabled: true, proxyUrl: "https://proxy.example/base" });
  assert.deepEqual(await handleAdminGithubProxySettings(request("GET"), env).then((response) => response.json()), {
    enabled: true,
    proxyUrl: "https://proxy.example/base",
  });
  assert.match(await env.EMBY_ICONS.get(GITHUB_PROXY_SETTINGS_KEY), /proxy\.example/);
});

test("admin cannot enable the proxy without a valid URL", async () => {
  const env = createEnvironment();
  const response = await handleAdminGithubProxySettings(new Request("https://example.com/api/admin/github-proxy", {
    method: "PUT",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled: true, proxyUrl: "javascript:alert(1)" }),
  }), env);
  assert.equal(response.status, 400);
});
