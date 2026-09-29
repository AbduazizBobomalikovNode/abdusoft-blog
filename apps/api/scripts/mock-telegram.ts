import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { Hono, type Context } from "hono";

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
const bannedMembers: { chatId: number | string; userId: number }[] = [];
/** `sendMessage` (matn) yoki `sendPhoto` (rasm) orqali yuborilgan xabarlar — `editMessageCaption`
 * matn-xabarga qo'llanilsa haqiqiy Telegram xatti-harakatini taqlid qilib xato qaytarish uchun. */
const messageKinds = new Map<number, "text" | "photo">();

/** `@username` -> barqaror (deterministik) manfiy raqamli chat id — `getChat` haqiqiy Telegram xatti-harakatini taqlid qiladi. */
const channelIdCache = new Map<string, number>();
function usernameToId(username: string): number {
  const clean = username.replace(/^@/, "");
  if (channelIdCache.has(clean)) return channelIdCache.get(clean)!;
  let hash = 0;
  for (const ch of clean) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const id = -(1_000_000_000_000 + (hash % 900_000_000));
  channelIdCache.set(clean, id);
  return id;
}

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
  uploadedFiles.length = 0;
  return c.json({ ok: true });
});
/** `Content-Type: multipart/form-data` bilan yuklangan fayllar (sendPhoto/sendMediaGroup uchun `InputFile`) — nom/hajm/qaysi so'rovga tegishli ekani shu yerda saqlanadi (sinov skriptlari tekshirishi uchun). */
interface RecordedFile {
  field: string;
  filename: string;
  size: number;
}
const uploadedFiles: { method: string; at: string; files: RecordedFile[] }[] = [];
app.get("/__uploads", (c) => c.json({ uploads: uploadedFiles }));
/** Sinov skriptlari uchun qulaylik — `@username` qanday raqamli id'ga aylantirilganini tekshirish (webhook fixture'lar shu id'ni ishlatishi kerak). */
app.get("/__chat-id/:username", (c) => c.json({ id: usernameToId(c.req.param("username")) }));
app.get("/__banned", (c) => c.json({ items: bannedMembers }));
/** Sinov skriptlari uchun — oxirgi yaratilgan xabar (sendMessage/sendPhoto) `message_id`si, ForceReply prompt kabi javobni "taxmin qilmasdan" bog'lash uchun. */
app.get("/__last-message-id", (c) => c.json({ id: messageIdCounter }));

/** grammY `InputFile` yuborilganda so'rov `multipart/form-data` shaklida keladi — matn maydonlari (JSON qiymatlar
 * bo'lsa parse qilinadi) va yuklangan fayllar (nom/hajm) shu yerda ajratib olinadi. `media` maydoni (sendMediaGroup)
 * JSON string ko'rinishida keladi — parse qilib, ichidagi har bir `attach://<id>` ga mos faylni bog'laymiz. */
async function parseMultipart(c: Context): Promise<{ body: Record<string, unknown>; files: RecordedFile[] }> {
  const form = await c.req.formData();
  const body: Record<string, unknown> = {};
  const files: RecordedFile[] = [];

  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      const buf = await value.arrayBuffer();
      files.push({ field: key, filename: value.name || `${key}.jpg`, size: buf.byteLength });
      continue;
    }
    body[key] = value;
  }

  if (typeof body.media === "string") {
    try {
      body.media = JSON.parse(body.media);
    } catch {
      // JSON emas — o'zgarishsiz qoldiramiz.
    }
  }

  return { body, files };
}

app.post("/:botToken/:method", async (c) => {
  const { botToken, method } = c.req.param();
  if (!botToken.startsWith("bot")) return c.json({ ok: false, error: "Noto'g'ri token formati" }, 404);

  const contentType = c.req.header("content-type") ?? "";
  let body: Record<string, unknown>;

  if (contentType.includes("multipart/form-data")) {
    const parsed = await parseMultipart(c);
    body = parsed.body;
    if (parsed.files.length > 0) {
      uploadedFiles.push({ method, at: new Date().toISOString(), files: parsed.files });
    }
  } else {
    body = await c.req.json().catch(() => ({}));
  }
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
      messageKinds.set(id, "text");
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
      messageKinds.set(id, "photo");
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

    case "sendMediaGroup": {
      const mediaArr = Array.isArray(body.media) ? (body.media as { type?: string; caption?: string }[]) : [];
      const messages = mediaArr.map((item, idx) => {
        const id = ++messageIdCounter;
        messageKinds.set(id, "photo");
        return {
          message_id: id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          caption: idx === 0 ? (item.caption ?? "") : undefined,
          photo: [{ file_id: `mock-file-id-${id}`, file_unique_id: `mock-unique-${id}`, width: 800, height: 600 }],
        };
      });
      return c.json(ok(messages));
    }

    case "editMessageText":
      messageKinds.set(body.message_id as number, "text");
      return c.json(
        ok({
          message_id: body.message_id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          text: body.text ?? "",
        }),
      );

    case "editMessageCaption": {
      const messageId = body.message_id as number;
      // Haqiqiy Telegram: matn (caption'siz) xabarga editMessageCaption chaqirilsa xato qaytaradi.
      if (messageKinds.get(messageId) === "text") {
        return c.json(
          { ok: false, error_code: 400, description: "Bad Request: there is no caption in the message to edit" },
          400,
        );
      }
      return c.json(
        ok({
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          caption: body.caption ?? "",
        }),
      );
    }

    case "deleteMessage":
      return c.json(ok(true));

    case "answerCallbackQuery":
      return c.json(ok(true));

    case "getChat": {
      const chatIdRaw = body.chat_id as string | number;
      const numericId = typeof chatIdRaw === "number" ? chatIdRaw : usernameToId(String(chatIdRaw));
      const username = typeof chatIdRaw === "string" ? chatIdRaw.replace(/^@/, "") : undefined;
      return c.json(
        ok({
          id: numericId,
          type: "channel",
          title: String(chatIdRaw),
          username,
        }),
      );
    }

    case "banChatMember": {
      bannedMembers.push({ chatId: body.chat_id as string | number, userId: body.user_id as number });
      return c.json(ok(true));
    }

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

/** Testlar uchun: mock serverni tasodifiy (bo'sh) portda ishga tushiradi. */
export function startMockTelegram(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// `tsx scripts/mock-telegram.ts` sifatida to'g'ridan-to'g'ri ishga tushirilganda — 4100-port.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Mock Telegram/Telegraph server ${info.port}-portda ishga tushdi.`);
  });
}
