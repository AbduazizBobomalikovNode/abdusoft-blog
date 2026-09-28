"use client";

import { useState } from "react";
import { toast } from "sonner";
import type {
  GeneralSettingsAdmin,
  GeneralSettingsPatch,
  GithubSettingsAdmin,
  GithubSettingsPatch,
  R2SettingsAdmin,
  R2SettingsPatch,
  SettingsTestResult,
  TelegramSettingsAdmin,
  TelegramSettingsPatch,
  TelegramStatus,
  TelegraphSettingsAdmin,
  TelegraphSettingsPatch,
  TurnstileSettingsAdmin,
  TurnstileSettingsPatch,
  UmamiSettingsAdmin,
  UmamiSettingsPatch,
} from "@blog/shared";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { SecretFieldRow, SwitchFieldRow, TextFieldRow } from "./field-row";
import { SectionShell } from "./section-shell";
import { useUnsavedGuard } from "./unsaved-guard";

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof AdminApiError ? e.message : fallback;
}

// ---------------------------------------------------------------------------
// Umumiy
// ---------------------------------------------------------------------------

export function GeneralSection({
  admin,
  onSave,
}: {
  admin: GeneralSettingsAdmin;
  onSave: (patch: GeneralSettingsPatch) => Promise<void>;
}) {
  const [siteName, setSiteName] = useState(admin.siteName.value);
  const [siteDescription, setSiteDescription] = useState(admin.siteDescription.value);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({ siteName, siteDescription });
      toast.success("Umumiy sozlamalar saqlandi");
    } catch (e) {
      toast.error(errorMessage(e, "Saqlab bo'lmadi"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionShell title="Umumiy" description="Sayt nomi va qisqa tavsifi — meta teglar va RSS'da ishlatiladi." saving={saving} onSave={handleSave}>
      <TextFieldRow id="general-siteName" label="Sayt nomi" field={admin.siteName} value={siteName} onChange={setSiteName} placeholder="abdusoft" />
      <TextFieldRow
        id="general-siteDescription"
        label="Sayt tavsifi"
        field={admin.siteDescription}
        value={siteDescription}
        onChange={setSiteDescription}
        placeholder="IT, AI, AGI, LLM va robototexnika haqida blog"
      />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export function TelegramSection({
  admin,
  telegramStatus,
  onSave,
  onTest,
  onRefreshStatus,
}: {
  admin: TelegramSettingsAdmin;
  telegramStatus: TelegramStatus;
  onSave: (patch: TelegramSettingsPatch) => Promise<void>;
  onTest: () => Promise<SettingsTestResult>;
  onRefreshStatus: () => void;
}) {
  const [adminChatId, setAdminChatId] = useState(admin.adminChatId.value);
  const [adminUserIds, setAdminUserIds] = useState(admin.adminUserIds.value);
  const [channelId, setChannelId] = useState(admin.channelId.value);
  const [notifyComments, setNotifyComments] = useState(admin.notifyComments.value);
  const [digestEnabled, setDigestEnabled] = useState(admin.digestEnabled.value);
  const [telegramDisplay, setTelegramDisplay] = useState(admin.telegramDisplay.value);
  const [botTokenDraft, setBotTokenDraft] = useState<string | undefined>(undefined);
  const [webhookSecretDraft, setWebhookSecretDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null);
  useUnsavedGuard(botTokenDraft !== undefined || webhookSecretDraft !== undefined);

  async function handleGenerateSecret() {
    setGenerating(true);
    try {
      const { secret } = await adminApi.generateSettingsSecret();
      setWebhookSecretDraft(secret);
    } catch {
      toast.error("Secret yaratib bo'lmadi");
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const patch: TelegramSettingsPatch = {
        adminChatId,
        adminUserIds,
        channelId,
        notifyComments,
        digestEnabled,
        telegramDisplay,
      };
      if (botTokenDraft !== undefined) patch.botToken = botTokenDraft;
      if (webhookSecretDraft !== undefined) patch.webhookSecret = webhookSecretDraft;
      await onSave(patch);
      setBotTokenDraft(undefined);
      setWebhookSecretDraft(undefined);
      toast.success("Telegram sozlamalari saqlandi");
      onRefreshStatus();
    } catch (e) {
      toast.error(errorMessage(e, "Saqlab bo'lmadi"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      setTestResult(await onTest());
      onRefreshStatus();
    } finally {
      setTesting(false);
    }
  }

  return (
    <SectionShell
      title="Telegram"
      description="Bot orqali izoh bildirishnomalari, kunlik hisobot va kanalga avtomatik post."
      saving={saving}
      onSave={handleSave}
      testing={testing}
      onTest={handleTest}
      testResult={testResult}
      extraHeader={admin.enabled ? <Badge>Yoqilgan</Badge> : <Badge variant="secondary">O&apos;chiq</Badge>}
    >
      {!admin.enabled && admin.disabledReason ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {admin.disabledReason}
        </p>
      ) : null}

      {telegramStatus.configured ? (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <div>Bot: {telegramStatus.me ? `@${telegramStatus.me.username ?? telegramStatus.me.id}` : "—"}</div>
          <div className="break-all">Webhook: {telegramStatus.webhook?.url || "o'rnatilmagan"}</div>
          {telegramStatus.webhook?.lastErrorMessage ? (
            <div className="text-destructive">Oxirgi xato: {telegramStatus.webhook.lastErrorMessage}</div>
          ) : null}
        </div>
      ) : null}

      <SecretFieldRow
        id="tg-botToken"
        label="Bot token"
        hint="@BotFather orqali olinadi: /newbot"
        field={admin.botToken}
        draftValue={botTokenDraft}
        onDraftChange={setBotTokenDraft}
      />

      <div className="flex flex-col gap-2">
        <SecretFieldRow
          id="tg-webhookSecret"
          label="Webhook secret"
          hint="Kamida 16 belgi — Telegram'dan kelayotgan soxta so'rovlarni bloklash uchun."
          field={admin.webhookSecret}
          draftValue={webhookSecretDraft}
          onDraftChange={setWebhookSecretDraft}
        />
        {admin.webhookSecret.source !== "env" ? (
          <Button type="button" variant="ghost" size="sm" className="w-fit" disabled={generating} onClick={() => void handleGenerateSecret()}>
            {generating ? "Yaratilmoqda…" : "Secret yaratish"}
          </Button>
        ) : null}
      </div>

      <TextFieldRow id="tg-adminChatId" label="Admin chat ID" hint="Bildirishnoma va hisobot shu chatga yuboriladi (DM yoki guruh)." field={admin.adminChatId} value={adminChatId} onChange={setAdminChatId} placeholder="-100123456789" />
      <TextFieldRow id="tg-adminUserIds" label="Admin user ID'lar" hint="Vergul bilan ajratilgan — faqat shu foydalanuvchilar bot buyruqlarini ishlata oladi." field={admin.adminUserIds} value={adminUserIds} onChange={setAdminUserIds} placeholder="42,100" />
      <TextFieldRow id="tg-channelId" label="Kanal ID" hint="@kanalnomi yoki -100... — chop etilgan postlar shu yerga yuboriladi." field={admin.channelId} value={channelId} onChange={setChannelId} placeholder="@kanalim" />

      <SwitchFieldRow id="tg-notifyComments" label="Izoh bildirishnomalari" hint="Yangi izohlar admin chatga yuboriladi" field={admin.notifyComments} checked={notifyComments} onChange={setNotifyComments} />
      <SwitchFieldRow id="tg-digestEnabled" label="Kunlik hisobot" hint="Har kuni 09:00 (Toshkent) da statistika yuboriladi" field={admin.digestEnabled} checked={digestEnabled} onChange={setDigestEnabled} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tg-telegramDisplay">Telegram izohlari qayerda ko&apos;rinadi</Label>
        <p className="text-xs text-muted-foreground">
          Kanalning muhokama guruhidan kelgan izohlar sayt sahifasida qanday ko&apos;rsatilishini belgilaydi.
        </p>
        <Select value={telegramDisplay} onValueChange={(v) => setTelegramDisplay(v as typeof telegramDisplay)}>
          <SelectTrigger id="tg-telegramDisplay" size="sm" className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin_only">Faqat admin panelda (standart) — saytda ko&apos;rinmaydi</SelectItem>
            <SelectItem value="mixed">Web izohlar bilan aralash — bitta ro&apos;yxatda, Telegram belgisi bilan</SelectItem>
            <SelectItem value="separate">Alohida bo&apos;lim — web izohlardan pastda, alohida ro&apos;yxatda</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Aniqlangan muhokama guruhi</Label>
        <p className="text-xs text-muted-foreground">
          Bot kanaldan avtomatik forward qilingan birinchi xabarni ko&apos;rgach o&apos;zi to&apos;ldiradi — qo&apos;lda kiritilmaydi.
        </p>
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {admin.discussionGroupId ?? "Hali aniqlanmagan — kanal postini muhokama guruhiga forward qildirib ko'ring"}
        </div>
      </div>

      <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Chat/user ID qanday olinadi?</p>
        <p>
          Telegram&apos;da <code>@userinfobot</code> yoki <code>@RawDataBot</code>ga yozing — shaxsiy (DM) chat ID sizning user
          ID&apos;ingiz bilan bir xil. Guruh/kanal ID&apos;lari odatda <code>-100</code> bilan boshlanadi (botni guruhga/kanalga admin
          qilib qo&apos;shgach shu bot orqali ko&apos;rinadi).
        </p>
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Telegraph
// ---------------------------------------------------------------------------

export function TelegraphSection({
  admin,
  onSave,
  onTest,
}: {
  admin: TelegraphSettingsAdmin;
  onSave: (patch: TelegraphSettingsPatch) => Promise<void>;
  onTest: () => Promise<SettingsTestResult>;
}) {
  const [enabled, setEnabled] = useState(admin.enabled.value);
  const [accessTokenDraft, setAccessTokenDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null);
  useUnsavedGuard(accessTokenDraft !== undefined);

  async function handleSave() {
    setSaving(true);
    try {
      const patch: TelegraphSettingsPatch = { enabled };
      if (accessTokenDraft !== undefined) patch.accessToken = accessTokenDraft;
      await onSave(patch);
      setAccessTokenDraft(undefined);
      toast.success("Telegraph sozlamalari saqlandi");
    } catch (e) {
      toast.error(errorMessage(e, "Saqlab bo'lmadi"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      setTestResult(await onTest());
    } finally {
      setTesting(false);
    }
  }

  return (
    <SectionShell
      title="Telegraph"
      description="Chop etilgan postlar Telegraph'ga ko'zgulanadi (tezkor, reklamasiz o'qish sahifasi)."
      saving={saving}
      onSave={handleSave}
      testing={testing}
      onTest={handleTest}
      testResult={testResult}
    >
      <SwitchFieldRow id="tp-enabled" label="Ko'zgulash yoqilgan" hint="Postlar chop etilganda avtomatik Telegraph'ga nusxalanadi" field={admin.enabled} checked={enabled} onChange={setEnabled} />
      <SecretFieldRow
        id="tp-accessToken"
        label="Access token"
        hint="Bo'sh qoldirilsa birinchi ko'zgulashda avtomatik yaratiladi."
        field={admin.accessToken}
        draftValue={accessTokenDraft}
        onDraftChange={setAccessTokenDraft}
      />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

export function TurnstileSection({
  admin,
  onSave,
  onTest,
}: {
  admin: TurnstileSettingsAdmin;
  onSave: (patch: TurnstileSettingsPatch) => Promise<void>;
  onTest: () => Promise<SettingsTestResult>;
}) {
  const [siteKey, setSiteKey] = useState(admin.siteKey.value);
  const [required, setRequired] = useState(admin.required.value);
  const [secretKeyDraft, setSecretKeyDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null);
  useUnsavedGuard(secretKeyDraft !== undefined);

  async function handleSave() {
    setSaving(true);
    try {
      const patch: TurnstileSettingsPatch = { siteKey, required };
      if (secretKeyDraft !== undefined) patch.secretKey = secretKeyDraft;
      await onSave(patch);
      setSecretKeyDraft(undefined);
      toast.success("Turnstile sozlamalari saqlandi");
    } catch (e) {
      toast.error(errorMessage(e, "Saqlab bo'lmadi"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      setTestResult(await onTest());
    } finally {
      setTesting(false);
    }
  }

  return (
    <SectionShell
      title="Turnstile"
      description="Cloudflare Turnstile — izoh formasidagi bot-himoya widget'i."
      saving={saving}
      onSave={handleSave}
      testing={testing}
      onTest={handleTest}
      testResult={testResult}
    >
      <TextFieldRow id="ts-siteKey" label="Site key" hint="Ommaviy kalit — izoh formasida ko'rinadi." field={admin.siteKey} value={siteKey} onChange={setSiteKey} placeholder="0x4AAAAAAA..." />
      <SecretFieldRow id="ts-secretKey" label="Secret key" field={admin.secretKey} draftValue={secretKeyDraft} onDraftChange={setSecretKeyDraft} />
      <SwitchFieldRow id="ts-required" label="Majburiy (fail-closed)" hint="Kalit bo'lmasa izoh yuborish butunlay rad etiladi (faqat prod'da ta'sir qiladi)" field={admin.required} checked={required} onChange={setRequired} />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

export function R2Section({
  admin,
  onSave,
  onTest,
}: {
  admin: R2SettingsAdmin;
  onSave: (patch: R2SettingsPatch) => Promise<void>;
  onTest: () => Promise<SettingsTestResult>;
}) {
  const [accountId, setAccountId] = useState(admin.accountId.value);
  const [accessKeyId, setAccessKeyId] = useState(admin.accessKeyId.value);
  const [bucket, setBucket] = useState(admin.bucket.value);
  const [publicUrl, setPublicUrl] = useState(admin.publicUrl.value);
  const [secretAccessKeyDraft, setSecretAccessKeyDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null);
  useUnsavedGuard(secretAccessKeyDraft !== undefined);

  async function handleSave() {
    setSaving(true);
    try {
      const patch: R2SettingsPatch = { accountId, accessKeyId, bucket, publicUrl };
      if (secretAccessKeyDraft !== undefined) patch.secretAccessKey = secretAccessKeyDraft;
      await onSave(patch);
      setSecretAccessKeyDraft(undefined);
      toast.success("R2 sozlamalari saqlandi");
    } catch (e) {
      toast.error(errorMessage(e, "Saqlab bo'lmadi"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      setTestResult(await onTest());
    } finally {
      setTesting(false);
    }
  }

  return (
    <SectionShell
      title="Cloudflare R2"
      description="Media fayllar (rasm) saqlash joyi. Sozlanmasa mahalliy diskka yoziladi."
      saving={saving}
      onSave={handleSave}
      testing={testing}
      onTest={handleTest}
      testResult={testResult}
    >
      <TextFieldRow id="r2-accountId" label="Account ID" field={admin.accountId} value={accountId} onChange={setAccountId} />
      <TextFieldRow id="r2-accessKeyId" label="Access key ID" field={admin.accessKeyId} value={accessKeyId} onChange={setAccessKeyId} />
      <SecretFieldRow id="r2-secretAccessKey" label="Secret access key" field={admin.secretAccessKey} draftValue={secretAccessKeyDraft} onDraftChange={setSecretAccessKeyDraft} />
      <TextFieldRow id="r2-bucket" label="Bucket nomi" field={admin.bucket} value={bucket} onChange={setBucket} />
      <TextFieldRow id="r2-publicUrl" label="Ommaviy URL" hint="R2.dev yoki custom domain" field={admin.publicUrl} value={publicUrl} onChange={setPublicUrl} placeholder="https://media.abdusoft.uz" />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Umami
// ---------------------------------------------------------------------------

export function UmamiSection({
  admin,
  onSave,
  onTest,
}: {
  admin: UmamiSettingsAdmin;
  onSave: (patch: UmamiSettingsPatch) => Promise<void>;
  onTest: () => Promise<SettingsTestResult>;
}) {
  const [apiUrl, setApiUrl] = useState(admin.apiUrl.value);
  const [websiteId, setWebsiteId] = useState(admin.websiteId.value);
  const [scriptUrl, setScriptUrl] = useState(admin.scriptUrl.value);
  const [username, setUsername] = useState(admin.username.value);
  const [apiKeyDraft, setApiKeyDraft] = useState<string | undefined>(undefined);
  const [passwordDraft, setPasswordDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null);
  useUnsavedGuard(apiKeyDraft !== undefined || passwordDraft !== undefined);

  async function handleSave() {
    setSaving(true);
    try {
      const patch: UmamiSettingsPatch = { apiUrl, websiteId, scriptUrl, username };
      if (apiKeyDraft !== undefined) patch.apiKey = apiKeyDraft;
      if (passwordDraft !== undefined) patch.password = passwordDraft;
      await onSave(patch);
      setApiKeyDraft(undefined);
      setPasswordDraft(undefined);
      toast.success("Umami sozlamalari saqlandi");
    } catch (e) {
      toast.error(errorMessage(e, "Saqlab bo'lmadi"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      setTestResult(await onTest());
    } finally {
      setTesting(false);
    }
  }

  return (
    <SectionShell
      title="Umami"
      description="Analitika — ommaviy sahifada skript, admin panelda statistika proxy uchun."
      saving={saving}
      onSave={handleSave}
      testing={testing}
      onTest={handleTest}
      testResult={testResult}
    >
      <TextFieldRow id="um-scriptUrl" label="Script URL" hint="Ommaviy sahifaga qo'shiladigan <script> manzili" field={admin.scriptUrl} value={scriptUrl} onChange={setScriptUrl} placeholder="https://umami.abdusoft.uz/script.js" />
      <TextFieldRow id="um-websiteId" label="Website ID" field={admin.websiteId} value={websiteId} onChange={setWebsiteId} />
      <TextFieldRow id="um-apiUrl" label="API URL" hint="Admin statistikasi uchun (Umami Cloud yoki self-hosted)" field={admin.apiUrl} value={apiUrl} onChange={setApiUrl} placeholder="https://umami.abdusoft.uz" />
      <SecretFieldRow id="um-apiKey" label="API key" hint="Bo'lsa username/parol shart emas (Umami Cloud)" field={admin.apiKey} draftValue={apiKeyDraft} onDraftChange={setApiKeyDraft} />
      <TextFieldRow id="um-username" label="Username" hint="Self-hosted uchun (apiKey bo'lmasa)" field={admin.username} value={username} onChange={setUsername} />
      <SecretFieldRow id="um-password" label="Parol" field={admin.password} draftValue={passwordDraft} onDraftChange={setPasswordDraft} />
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function GithubSection({
  admin,
  onSave,
  onTest,
}: {
  admin: GithubSettingsAdmin;
  onSave: (patch: GithubSettingsPatch) => Promise<void>;
  onTest: () => Promise<SettingsTestResult>;
}) {
  const [clientId, setClientId] = useState(admin.clientId.value);
  const [loginEnabled, setLoginEnabled] = useState(admin.loginEnabled.value);
  const [clientSecretDraft, setClientSecretDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null);
  useUnsavedGuard(clientSecretDraft !== undefined);

  async function handleSave() {
    setSaving(true);
    try {
      const patch: GithubSettingsPatch = { clientId, loginEnabled };
      if (clientSecretDraft !== undefined) patch.clientSecret = clientSecretDraft;
      await onSave(patch);
      setClientSecretDraft(undefined);
      toast.success("GitHub sozlamalari saqlandi");
    } catch (e) {
      toast.error(errorMessage(e, "Saqlab bo'lmadi"));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      setTestResult(await onTest());
    } finally {
      setTesting(false);
    }
  }

  return (
    <SectionShell
      title="GitHub"
      description="GitHub OAuth — izohlovchilar GitHub bilan kirishi mumkin bo'ladi."
      saving={saving}
      onSave={handleSave}
      testing={testing}
      onTest={handleTest}
      testResult={testResult}
      extraHeader={admin.restartRequired ? <Badge variant="destructive">Saqlangandan so&apos;ng API restart kerak</Badge> : null}
    >
      <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        GitHub OAuth ilovasida Authorization callback URL sifatida shuni kiriting: <br />
        <code className="break-all">{admin.callbackUrl}</code>
      </p>
      <TextFieldRow id="gh-clientId" label="Client ID" field={admin.clientId} value={clientId} onChange={setClientId} />
      <SecretFieldRow id="gh-clientSecret" label="Client secret" field={admin.clientSecret} draftValue={clientSecretDraft} onDraftChange={setClientSecretDraft} />
      <SwitchFieldRow id="gh-loginEnabled" label="Login tugmasi ko'rsatilsin" hint="Izoh formasida 'GitHub bilan kirish' tugmasi" field={admin.loginEnabled} checked={loginEnabled} onChange={setLoginEnabled} />
    </SectionShell>
  );
}
