import { Hono } from "hono";

export const healthRoute = new Hono().get("/", (c) => {
  return c.json({ status: "ok", time: new Date().toISOString() });
});
