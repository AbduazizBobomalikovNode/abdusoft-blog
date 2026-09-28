import { serve } from "@hono/node-server";
import { Hono } from "hono";

/**
 * Telegram Bot API va Telegraph API'ning juda soddalashtirilgan mahalliy
 * taqlidi — Phase 6 (Telegram integratsiyasi) ni haqiqiy tokensiz sinash
 * uchun. `TELEGRAM_API_ROOT`/`TELEGRAPH_API_ROOT` shu serverga
 * yo'naltirilganda API kodi hech narsani bilmagan holda ishlayveradi.
 *
 * Ishga tushirish: `tsx scripts/mock-telegram.ts` (port 4100).
 */

const PORT = 4100;

interface CallRecord {
  method: string;
  path: string;
  body: unknown;
  at: string;
}

const calls: CallRecord[] = [];
let messageIdCounter = 1000;
let telegraphPageCounter = 1;
let storedWebhook: { url: string; secret?: string } | null = null;

const app = new Hono();

function ok(result: unknown) {
  return { ok: true, result };
}

function record(method: string, path: string, body: unknown) {
  calls.push({ method, path, body, at: new Date().toISOString() });
}

app.get("/__calls", (c) => c.json({ calls }));
app.delete("/__calls", (c) => {
  calls.length = 0;
  return c.json({ ok: true });
});

app.post("/:botToken/:method", async (c) => {
  const { botToken, method } = c.req.param();
  if (!botToken.startsWith("bot")) return c.json({ ok: false, error: "Noto'g'ri token formati" }, 404);

  const body = await c.req.json().catch(() => ({}));
  record(method, c.req.path, body);

  switch (method) {
    case "getMe":
      return c.json(ok({ id: 123456789, is_bot: true, first_name: "TestBot", username: "test_bot" }));

    case "setWebhook":
      storedWebhook = { url: body.url as string, secret: body.secret_token as string | undefined };
      return c.json(ok(true));

    case "getWebhookInfo":
      return c.json(
        ok({
          url: storedWebhook?.url ?? "",
          has_custom_certificate: false,
          pending_update_count: 0,
        }),
      );

    case "sendMessage": {
      const id = ++messageIdCounter;
      return c.json(
        ok({
          message_id: id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          text: body.text ?? "",
        }),
      );
    }

    case "sendPhoto": {
      const id = ++messageIdCounter;
      return c.json(
        ok({
          message_id: id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          caption: body.caption ?? "",
          photo: [{ file_id: "mock-file-id", file_unique_id: "mock-unique", width: 800, height: 600 }],
        }),
      );
    }

    case "editMessageText":
      return c.json(
        ok({
          message_id: body.message_id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          text: body.text ?? "",
        }),
      );

    case "editMessageCaption":
      return c.json(
        ok({
          message_id: body.message_id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          caption: body.caption ?? "",
        }),
      );

    case "deleteMessage":
      return c.json(ok(true));

    case "answerCallbackQuery":
      return c.json(ok(true));

    default:
      return c.json(ok(true));
  }
});

app.post("/createAccount", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  record("createAccount", c.req.path, body);
  return c.json(
    ok({
      short_name: body.short_name ?? "blog",
      author_name: body.author_name ?? "",
      author_url: "",
      access_token: "mock-telegraph-access-token",
      auth_url: "https://edit.telegra.ph/auth/mock",
    }),
  );
});

app.post("/createPage", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  record("createPage", c.req.path, body);
  const path = `mock-page-${telegraphPageCounter++}`;
  return c.json(
    ok({
      path,
      url: `https://telegra.ph/${path}`,
      title: body.title ?? "",
      description: "",
      author_name: body.author_name ?? "",
      content: body.content ?? [],
      views: 0,
      can_edit: true,
    }),
  );
});

app.post("/editPage", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  record("editPage", c.req.path, body);
  const path = (body.path as string) ?? `mock-page-${telegraphPageCounter}`;
  return c.json(
    ok({
      path,
      url: `https://telegra.ph/${path}`,
      title: body.title ?? "",
      description: "",
      author_name: body.author_name ?? "",
      content: body.content ?? [],
      views: 0,
      can_edit: true,
    }),
  );
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Mock Telegram/Telegraph server ${info.port}-portda ishga tushdi.`);
});
