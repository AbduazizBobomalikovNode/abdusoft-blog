import { headers } from "next/headers";
import type { Metadata } from "next";
import { DEFAULT_POST_SETTINGS, DEFAULT_SOCIAL_LINKS, DEFAULT_TELEGRAM_SETTINGS, type AdminField, type SettingsAdmin } from "@blog/shared";
import { SiteSettingsForm } from "@/components/admin/site-settings-form";
import { getAdminSettings, getAdminSiteSettings, getAdminTelegramStatus } from "@/lib/api";

export const metadata: Metadata = { title: "Sozlamalar" };

function emptyField<T>(value: T): AdminField<T> {
  return { value, source: "none", isSet: false, envVar: null };
}

/** API vaqtincha ishlamay qolgan holat uchun — bo'sh (hech narsa sozlanmagan) integratsiya sozlamalari. */
const EMPTY_INTEGRATIONS: SettingsAdmin = {
  telegram: {
    botToken: emptyField(""),
    webhookSecret: emptyField(""),
    adminChatId: emptyField(""),
    adminUserIds: emptyField(""),
    channelId: emptyField(""),
    apiRoot: emptyField("https://api.telegram.org"),
    notifyComments: emptyField(true),
    digestEnabled: emptyField(false),
    enabled: false,
    disabledReason: null,
  },
  telegraph: { enabled: emptyField(false), accessToken: emptyField("") },
  turnstile: { siteKey: emptyField(""), secretKey: emptyField(""), required: emptyField(false) },
  r2: {
    accountId: emptyField(""),
    accessKeyId: emptyField(""),
    secretAccessKey: emptyField(""),
    bucket: emptyField(""),
    publicUrl: emptyField(""),
  },
  umami: {
    apiUrl: emptyField(""),
    websiteId: emptyField(""),
    scriptUrl: emptyField(""),
    apiKey: emptyField(""),
    username: emptyField(""),
    password: emptyField(""),
  },
  github: {
    clientId: emptyField(""),
    clientSecret: emptyField(""),
    loginEnabled: emptyField(false),
    restartRequired: false,
    callbackUrl: "",
  },
  general: { siteName: emptyField("abdusoft"), siteDescription: emptyField("") },
};

export default async function AdminSettingsPage() {
  const headersList = await headers();
  const cookie = headersList.get("cookie");
  const [settings, integrations, telegramStatus] = await Promise.all([
    getAdminSiteSettings(cookie),
    getAdminSettings(cookie),
    getAdminTelegramStatus(cookie),
  ]);

  const initial = settings ?? {
    about: { json: { type: "doc", content: [] }, html: "" },
    social: DEFAULT_SOCIAL_LINKS,
    defaultPostSettings: DEFAULT_POST_SETTINGS,
    telegram: DEFAULT_TELEGRAM_SETTINGS,
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sozlamalar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sayt haqida, ijtimoiy havolalar, standart post sozlamalari va integratsiyalar (Telegram, Telegraph, Turnstile, R2, Umami,
          GitHub).
        </p>
      </div>

      <SiteSettingsForm
        initial={initial}
        initialIntegrations={integrations ?? EMPTY_INTEGRATIONS}
        initialTelegramStatus={telegramStatus ?? { configured: false }}
      />
    </div>
  );
}
