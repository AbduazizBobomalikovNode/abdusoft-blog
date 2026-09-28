import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { config } from "./config.js";
import { startScheduler } from "./lib/scheduler.js";
import { initTelegram } from "./telegram/bot.js";

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`API ${config.API_ORIGIN} da ishga tushdi (port ${info.port})`);
});

initTelegram();
startScheduler();
console.log("Post scheduler ishga tushdi (har daqiqada tekshiradi).");
