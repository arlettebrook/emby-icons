import { cleanupDatabase } from "../functions/_shared/cleanup.js";

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cleanupDatabase(env).catch((error) => {
      console.error("D1 cleanup failed", error);
      throw error;
    }));
  },
};
