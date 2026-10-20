import { hasAdminSession } from "./_shared/admin.js";
import { ensureDatabaseSchema } from "./_shared/database.js";
import { runPeriodicMaintenance } from "./_shared/maintenance.js";

const protectedPages = new Set(["/admin.html", "/review.html"]);

function isApiRequest(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function databaseUnavailableResponse() {
  return new Response(JSON.stringify({ error: "数据库暂时不可用，请稍后重试。" }), {
    status: 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "30",
    },
  });
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const pathname = requestUrl.pathname;

  if (context.env?.DB) {
    try {
      await ensureDatabaseSchema(context.env);
      const maintenance = runPeriodicMaintenance(context.env).catch((error) => {
        console.warn("Periodic maintenance failed", error);
      });
      if (typeof context.waitUntil === "function") context.waitUntil(maintenance);
      else void maintenance;
    } catch (error) {
      console.error(`数据库自动迁移失败：${error instanceof Error ? error.stack || error.message : String(error)}`);
      if (isApiRequest(pathname)) return databaseUnavailableResponse();
    }
  }

  const loginRequested = pathname === "/admin.html" && requestUrl.searchParams.get("login") === "1";
  if (protectedPages.has(pathname) && !loginRequested && !(await hasAdminSession(context.request, context.env))) {
    const loginUrl = new URL("/admin.html", context.request.url);
    loginUrl.searchParams.set("login", "1");
    loginUrl.searchParams.set("next", pathname === "/review.html" ? "/admin.html#moderation" : pathname);
    return Response.redirect(loginUrl, 302);
  }
  return context.next();
}
