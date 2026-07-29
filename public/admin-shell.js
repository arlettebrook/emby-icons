const logoutButton = document.querySelector("#logout-button");

logoutButton?.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await fetch("/api/admin/logout", { method: "POST" });
  } finally {
    sessionStorage.removeItem("emby-icons-admin-token");
    window.location.assign("/admin.html?login=1");
  }
});
