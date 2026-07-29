const SESSION_COOKIE = "emby_admin_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function toBase64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value) {
  const remainder = value.length % 4;
  const padding = remainder === 0 ? "" : "=".repeat(4 - remainder);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + padding;
  const binary = atob(padded);
  return new Uint8Array([...binary].map((character) => character.charCodeAt(0)));
}

async function sign(value, env) {
  const secret = String(env.ADMIN_SESSION_SECRET || env.ADMIN_TOKEN || "").trim();
  if (!secret) return "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function safeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  leftBytes.forEach((byte, index) => { difference |= byte ^ rightBytes[index]; });
  return difference === 0;
}

export async function createAdminSession(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = toBase64Url(JSON.stringify({ exp: expiresAt }));
  return `${payload}.${await sign(payload, env)}`;
}

export async function hasAdminSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookie = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return false;
  const value = cookie.slice(SESSION_COOKIE.length + 1);
  const [payload, suppliedSignature] = value.split(".");
  if (!payload || !suppliedSignature) return false;
  const expectedSignature = await sign(payload, env);
  if (!(await safeEqual(expectedSignature, suppliedSignature))) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function sessionCookie(request, session) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${session}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

export function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

export { SESSION_COOKIE };
