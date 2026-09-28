import { Hono } from "hono";
import { getDevice } from "../lib/device.js";
import { getSessionUser } from "../lib/session.js";

/**
 * Qurilma cookie'sini ta'minlaydi (yo'q bo'lsa yaratadi) va joriy Better Auth
 * sessiyasi haqida ma'lumot beradi. Izohlar/reaksiyalar UI'si shu bilan
 * boshlanadi.
 */
export const meRoute = new Hono().get("/", async (c) => {
  getDevice(c);
  const sessionUser = await getSessionUser(c);

  return c.json({
    device: true,
    user: sessionUser
      ? { name: sessionUser.name, image: sessionUser.image, role: sessionUser.role }
      : null,
  });
});
