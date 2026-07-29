import { hasAdminSession } from "./_shared/admin.js";

const protectedPages = new Set(["/admin.html", "/review.html"]);

export async function onRequest(context) {
  const pathname = new URL(context.request.url).pathname;
  if (protectedPages.has(pathname) && !(await hasAdminSession(context.request, context.env))) {
    const loginUrl = new URL("/admin-login.html", context.request.url);
    loginUrl.searchParams.set("next", pathname === "/review.html" ? "/admin.html#moderation" : pathname);
    return Response.redirect(loginUrl, 302);
  }
  return context.next();
}
