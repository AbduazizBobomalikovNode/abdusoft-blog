import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import { siteSettings } from "../db/schema.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import {
  SettingsValidationError,
  getSettings,
  getSettingsForAdmin,
  invalidateSettingsCache,
  onSettingsChange,
  saveSettings,
} from "./settings.js";

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_ADMIN_CHAT_ID",
  "TELEGRAM_ADMIN_USER_IDS",
  "TELEGRAM_CHANNEL_ID",
  "TELEGRAM_API_ROOT",
  "TURNSTILE_SECRET_KEY",
  "REQUIRE_TURNSTILE",
  "R2_ACCOUNT_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SITE_NAME",
];
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

function resetEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

beforeAll(async () => {
  await migrateTestDb();
});

beforeEach(async () => {
  resetEnv();
  await db.delete(siteSettings);
  invalidateSettingsCache();
});

afterEach(async () => {
  resetEnv();
  await db.delete(siteSettings);
  invalidateSettingsCache();
});

describe("settings precedence — env > db > none", () => {
  it("uses the default (none) when neither env nor DB provide a value", async () => {
    const admin = await getSettingsForAdmin();
    expect(admin.telegram.channelId.source).toBe("none");
    expect(admin.telegram.channelId.isSet).toBe(false);

    const settings = await getSettings();
    expect(settings.telegram.channelId).toBe("");
    expect(settings.telegram.enabled).toBe(false);
  });

  it("DB value wins over 'none' once saved", async () => {
    await saveSettings({ telegram: { channelId: "@testchan" } });

    const admin = await getSettingsForAdmin();
    expect(admin.telegram.channelId.source).toBe("db");
    expect(admin.telegram.channelId.value).toBe("@testchan");

    const settings = await getSettings();
    expect(settings.telegram.channelId).toBe("@testchan");
  });

  it("env value wins over DB value (and locks the field)", async () => {
    await saveSettings({ telegram: { channelId: "@fromdb" } });

    process.env.TELEGRAM_CHANNEL_ID = "@fromenv";
    invalidateSettingsCache();

    const admin = await getSettingsForAdmin();
    expect(admin.telegram.channelId.source).toBe("env");
    expect(admin.telegram.channelId.value).toBe("@fromenv");
    expect(admin.telegram.channelId.envVar).toBe("TELEGRAM_CHANNEL_ID");

    const settings = await getSettings();
    expect(settings.telegram.channelId).toBe("@fromenv");
  });

  it("rejects a PUT attempt to a field currently locked by env", async () => {
    process.env.TELEGRAM_CHANNEL_ID = "@fromenv";
    invalidateSettingsCache();

    await expect(saveSettings({ telegram: { channelId: "@shouldfail" } })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
  });
});

describe("mask-keep semantics", () => {
  it("an omitted secret field keeps the previously stored value", async () => {
    await saveSettings({ telegram: { botToken: "123456:AAtestBotTokenValue" } });
    let settings = await getSettings();
    expect(settings.telegram.botToken).toBe("123456:AAtestBotTokenValue");

    // Save something unrelated in the same section — botToken field omitted entirely.
    await saveSettings({ telegram: { channelId: "@keepme" } });
    settings = await getSettings();
    expect(settings.telegram.botToken).toBe("123456:AAtestBotTokenValue");
  });

  it("a masked sentinel value (starting with ••••) is treated as 'keep', not overwritten", async () => {
    await saveSettings({ telegram: { botToken: "123456:AAtestBotTokenValue" } });
    await saveSettings({ telegram: { botToken: "••••alue" } });

    const settings = await getSettings();
    expect(settings.telegram.botToken).toBe("123456:AAtestBotTokenValue");
  });

  it("an explicit empty string clears the secret", async () => {
    await saveSettings({ telegram: { botToken: "123456:AAtestBotTokenValue" } });
    await saveSettings({ telegram: { botToken: "" } });

    const settings = await getSettings();
    expect(settings.telegram.botToken).toBe("");
  });

  it("the admin view masks a stored secret to ••••<last4>", async () => {
    await saveSettings({ telegram: { botToken: "123456:AAtestBotTokenValue" } });

    const admin = await getSettingsForAdmin();
    expect(admin.telegram.botToken.value).toBe("••••alue");
    expect(admin.telegram.botToken.isSet).toBe(true);
  });
});

describe("validation", () => {
  it("rejects non-numeric adminUserIds", async () => {
    await expect(saveSettings({ telegram: { adminUserIds: "abc,123" } })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
  });

  it("accepts a comma-separated numeric adminUserIds list", async () => {
    await saveSettings({ telegram: { adminUserIds: "42, 100" } });
    const settings = await getSettings();
    expect(settings.telegram.adminUserIds).toEqual([42, 100]);
  });

  it("rejects a malformed channelId", async () => {
    await expect(saveSettings({ telegram: { channelId: "not-a-channel" } })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
  });

  it("accepts @channel and -100… channelId formats", async () => {
    await saveSettings({ telegram: { channelId: "@my_channel" } });
    expect((await getSettings()).telegram.channelId).toBe("@my_channel");

    await saveSettings({ telegram: { channelId: "-1001234567890" } });
    expect((await getSettings()).telegram.channelId).toBe("-1001234567890");
  });

  it("rejects a webhookSecret shorter than 16 characters", async () => {
    await expect(saveSettings({ telegram: { webhookSecret: "short" } })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
  });

  it("accepts a webhookSecret of 16+ characters and enables the bot once a token is also set", async () => {
    await saveSettings({
      telegram: { botToken: "123:TEST", webhookSecret: "a".repeat(16) },
    });
    const settings = await getSettings();
    expect(settings.telegram.enabled).toBe(true);
    expect(settings.telegram.disabledReason).toBeNull();
  });

  it("keeps the bot disabled (with a reason) when token is set but secret is too short", async () => {
    await saveSettings({ telegram: { botToken: "123:TEST" } });
    const settings = await getSettings();
    expect(settings.telegram.enabled).toBe(false);
    expect(settings.telegram.disabledReason).toMatch(/webhook secret/);
  });
});

describe("onSettingsChange", () => {
  it("notifies subscribers after a successful save", async () => {
    const cb = vi.fn();
    const unsubscribe = onSettingsChange(cb);
    await saveSettings({ general: { siteName: "Test Blog" } });
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    await saveSettings({ general: { siteName: "Another" } });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
