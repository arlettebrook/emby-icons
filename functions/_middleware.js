import { hasAdminSession } from "./_shared/admin.js";

const protectedPages = new Set(["/admin.html", "/review.html"]);

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const pathname = requestUrl.pathname;
  const loginRequested = pathname === "/admin.html" && requestUrl.searchParams.get("login") === "1";
  if (protectedPages.has(pathname) && !loginRequested && !(await hasAdminSession(context.request, context.env))) {
    const loginUrl = new URL("/admin.html", context.request.url);
    loginUrl.searchParams.set("login", "1");
    loginUrl.searchParams.set("next", pathname === "/review.html" ? "/admin.html#moderation" : pathname);
    return Response.redirect(loginUrl, 302);
  }
  return context.next();
}
