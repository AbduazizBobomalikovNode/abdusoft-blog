import { Hono } from "hono";
import { SettingsPatchSchema, SettingsSectionSchema, type SettingsTestResult } from "@blog/shared";
import { bootedGithubConfig } from "../lib/auth.js";
import { requireAdmin } from "../lib/require-admin.js";
import {
  SettingsValidationError,
  generateRandomSecret,
  getSettings,
  getSettingsForAdmin,
  saveSettings,
} from "../lib/settings.js";
import { testTelegraphConnection } from "../telegram/telegraph.js";
import { bot } from "../telegram/client.js";
import { testUmamiConnection } from "../lib/umami.js";

async function testTelegram(): Promise<SettingsTestResult> {
  const settings = await getSettings();

  if (!settings.telegram.enabled || !bot) {
    return {
      ok: false,
      message: settings.telegram.disabledReason ?? "Telegram bot sozlanmagan (bot token yoki webhook secret yo'q)",
    };
  }

  const [me, webhookInfo] = await Promise.all([
    bot.api.getMe().catch(() => null),
    bot.api.getWebhookInfo().catch(() => null),
  ]);

  if (!me) {
    return { ok: false, message: "getMe muvaffaqiyatsiz — bot token noto'g'ri bo'lishi mumkin" };
  }

  if (settings.telegram.adminChatId) {
    try {
      await bot.api.sendMessage(settings.telegram.adminChatId, "Salom! Bot ulandi ✅");
    } catch (error) {
      return {
        ok: false,
        message: `Bot topildi (@${me.username ?? me.id}), lekin admin chatga xabar yuborilmadi: ${error instanceof Error ? error.message : "noma'lum xato"}`,
      };
    }
  }

  return {
    ok: true,
    message: `Bot topildi: @${me.username ?? me.id}. Webhook: ${webhookInfo?.url || "o'rnatilmagan"}`,
    details: { me, webhook: webhookInfo },
  };
}

async function testR2(): Promise<SettingsTestResult> {
  const { r2 } = await getSettings();
  if (!r2.enabled) {
    return { ok: false, message: "R2 to'liq sozlanmagan — barcha maydonlar (accountId, accessKeyId, secretAccessKey, bucket, publicUrl) kerak" };
  }

  try {
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    });
    const key = `__settings-test/${Date.now()}.txt`;
    await client.send(new PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: "settings-test", ContentType: "text/plain" }));
    await client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
    await client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
    return { ok: true, message: "R2 ulanish muvaffaqiyatli — yozish/o'qish/o'chirish sinovdan o'tdi" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "R2 ulanish xatosi" };
  }
}

async function testTelegraph(): Promise<SettingsTestResult> {
  try {
    const result = await testTelegraphConnection();
    return result;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Telegraph ulanish xatosi" };
  }
}

async function testUmami(): Promise<SettingsTestResult> {
  return testUmamiConnection();
}

async function testGithub(): Promise<SettingsTestResult> {
  const { github } = await getSettings();
  if (!github.providerEnabled) {
    return { ok: false, message: "GitHub clientId/clientSecret sozlanmagan" };
  }
  return { ok: true, message: "GitHub clientId va clientSecret sozlangan (haqiqiy OAuth login'ni tekshirish uchun brauzerda sinab ko'ring)" };
}

async function testTurnstile(): Promise<SettingsTestResult> {
  const { turnstile } = await getSettings();
  if (!turnstile.secretKey) {
    return { ok: false, message: "Turnstile secretKey sozlanmagan" };
  }
  return { ok: true, message: "Turnstile secretKey sozlangan" };
}

export const adminSettingsRoute = new Hono()
  .use("*", requireAdmin)
  .get("/", async (c) => {
    const admin = await getSettingsForAdmin();
    const current = await getSettings();
    admin.github.restartRequired =
      current.github.clientId !== bootedGithubConfig.clientId || current.github.clientSecret !== bootedGithubConfig.clientSecret;
    return c.json(admin);
  })
  .put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SettingsPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    try {
      await saveSettings(parsed.data);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return c.json({ error: "Sozlamalarda xatolik topildi", fields: error.fields }, 400);
      }
      throw error;
    }

    const admin = await getSettingsForAdmin();
    const current = await getSettings();
    admin.github.restartRequired =
      current.github.clientId !== bootedGithubConfig.clientId || current.github.clientSecret !== bootedGithubConfig.clientSecret;
    return c.json(admin);
  })
  .post("/generate-secret", (c) => c.json({ secret: generateRandomSecret() }))
  .post("/test/:section", async (c) => {
    const parsed = SettingsSectionSchema.safeParse(c.req.param("section"));
    if (!parsed.success) return c.json({ error: "Noto'g'ri bo'lim" }, 400);

    let result: SettingsTestResult;
    switch (parsed.data) {
      case "telegram":
        result = await testTelegram();
        break;
      case "r2":
        result = await testR2();
        break;
      case "telegraph":
        result = await testTelegraph();
        break;
      case "umami":
        result = await testUmami();
        break;
      case "github":
        result = await testGithub();
        break;
      case "turnstile":
        result = await testTurnstile();
        break;
    }

    return c.json(result);
  });
