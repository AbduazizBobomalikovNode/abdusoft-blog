"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type {
  GeneralSettingsPatch,
  GithubSettingsPatch,
  R2SettingsPatch,
  SettingsAdmin,
  SettingsSection,
  SettingsTestResult,
  SiteSettingsAdmin,
  SocialLinks,
  TelegramSettingsPatch,
  TelegramStatus,
  TelegraphSettingsPatch,
  TurnstileSettingsPatch,
  UmamiSettingsPatch,
} from "@blog/shared";
import { SETTING_SWITCHES } from "@/components/admin/post-settings-fields";
import {
  GeneralSection,
  GithubSection,
  R2Section,
  TelegramSection,
  TelegraphSection,
  TurnstileSection,
  UmamiSection,
} from "@/components/admin/settings/sections";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { cn } from "@/lib/utils";

const SOCIAL_FIELDS: { key: keyof SocialLinks; label: string; placeholder: string }[] = [
  { key: "telegram", label: "Telegram", placeholder: "https://t.me/..." },
  { key: "github", label: "GitHub", placeholder: "https://github.com/..." },
  { key: "x", label: "X (Twitter)", placeholder: "https://x.com/..." },
  { key: "email", label: "Email", placeholder: "siz@misol.uz" },
];

type TabValue =
  | "umumiy"
  | "haqida"
  | "ijtimoiy"
  | "telegram"
  | "telegraph"
  | "turnstile"
  | "r2"
  | "umami"
  | "github";

interface TabDef {
  value: TabValue;
  label: string;
}

// Tab'lar ikki guruhga bo'lingan — "Sayt" (kontent) va "Integratsiyalar" (tashqi
// xizmatlar, har birida sozlanganlik holatini bildiruvchi nuqta bor).
const TAB_GROUPS: { label: string; tabs: TabDef[] }[] = [
  {
    label: "Sayt",
    tabs: [
      { value: "umumiy", label: "Umumiy" },
      { value: "haqida", label: "Haqida" },
      { value: "ijtimoiy", label: "Ijtimoiy" },
    ],
  },
  {
    label: "Integratsiyalar",
    tabs: [
      { value: "telegram", label: "Telegram" },
      { value: "telegraph", label: "Telegraph" },
      { value: "turnstile", label: "Turnstile" },
      { value: "r2", label: "R2" },
      { value: "umami", label: "Umami" },
      { value: "github", label: "GitHub" },
    ],
  },
];
const TABS: TabDef[] = TAB_GROUPS.flatMap((group) => group.tabs);

type IntegrationStatus = "green" | "amber" | "gray";

/** `setFlags`dan nechtasi to'ldirilgan bo'lsa: hammasi = yashil, ba'zisi = amber, hech biri = kulrang. */
function fieldStatus(setFlags: boolean[]): IntegrationStatus {
  const setCount = setFlags.filter(Boolean).length;
  if (setCount === 0) return "gray";
  if (setCount === setFlags.length) return "green";
  return "amber";
}

function integrationStatuses(integrations: SettingsAdmin): Partial<Record<TabValue, IntegrationStatus>> {
  return {
    telegram: fieldStatus([integrations.telegram.botToken.isSet, integrations.telegram.adminChatId.isSet]),
    telegraph: fieldStatus([integrations.telegraph.accessToken.isSet]),
    turnstile: fieldStatus([integrations.turnstile.siteKey.isSet, integrations.turnstile.secretKey.isSet]),
    r2: fieldStatus([
      integrations.r2.accountId.isSet,
      integrations.r2.accessKeyId.isSet,
      integrations.r2.secretAccessKey.isSet,
      integrations.r2.bucket.isSet,
      integrations.r2.publicUrl.isSet,
    ]),
    umami: fieldStatus([integrations.umami.scriptUrl.isSet, integrations.umami.websiteId.isSet]),
    github: fieldStatus([integrations.github.clientId.isSet, integrations.github.clientSecret.isSet]),
  };
}

const STATUS_DOT_CLASS: Record<IntegrationStatus, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  gray: "bg-muted-foreground/30",
};

const STATUS_DOT_LABEL: Record<IntegrationStatus, string> = {
  green: "sozlangan",
  amber: "qisman sozlangan",
  gray: "sozlanmagan",
};

function StatusDot({ status }: { status: IntegrationStatus }) {
  return (
    <span
      title={STATUS_DOT_LABEL[status]}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[status])}
    />
  );
}

// Tiptap faqat "Haqida" yorlig'i ochilganda yuklanadi (sozlamalar sahifasining boshlang'ich hajmi o'smaydi).
const AboutTab = dynamic(() => import("./about-tab").then((m) => m.AboutTab), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-xl bg-muted" aria-busy="true" />,
});

function SocialTab({ initial }: { initial: SocialLinks }) {
  const [social, setSocial] = useState<SocialLinks>(initial);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await adminApi.updateSiteSettings({ social });
      toast.success("Ijtimoiy havolalar saqlandi");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Saqlab bo'lmadi");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        {SOCIAL_FIELDS.map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`social-${field.key}`} className="text-xs text-muted-foreground">
              {field.label}
            </Label>
            <Input
              id={`social-${field.key}`}
              value={social[field.key] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) => setSocial((prev) => ({ ...prev, [field.key]: event.target.value || null }))}
            />
          </div>
        ))}
        <Button onClick={() => void handleSave()} disabled={saving} className="w-fit" size="sm">
          {saving ? "Saqlanmoqda…" : "Saqlash"}
        </Button>
      </CardContent>
    </Card>
  );
}

function DefaultPostSettingsCard({ initial }: { initial: SiteSettingsAdmin["defaultPostSettings"] }) {
  const [defaultSettings, setDefaultSettings] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await adminApi.updateSiteSettings({ defaultPostSettings: defaultSettings });
      toast.success("Standart post sozlamalari saqlandi");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Saqlab bo'lmadi");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <Label>Yangi postlar uchun standart sozlamalar</Label>
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {SETTING_SWITCHES.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={`default-${item.key}`}>{item.label}</Label>
                <p className="text-xs text-muted-foreground">{item.hint}</p>
              </div>
              <Switch
                id={`default-${item.key}`}
                checked={defaultSettings[item.key]}
                onCheckedChange={(checked) => setDefaultSettings((prev) => ({ ...prev, [item.key]: checked }))}
              />
            </div>
          ))}
        </div>
        <Button onClick={() => void handleSave()} disabled={saving} className="w-fit" size="sm">
          {saving ? "Saqlanmoqda…" : "Saqlash"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function SiteSettingsForm({
  initial,
  initialIntegrations,
  initialTelegramStatus,
}: {
  initial: SiteSettingsAdmin;
  initialIntegrations: SettingsAdmin;
  initialTelegramStatus: TelegramStatus;
}) {
  const [integrations, setIntegrations] = useState<SettingsAdmin>(initialIntegrations);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus>(initialTelegramStatus);
  // `/admin/sozlamalar?tab=umami` kabi chuqur havolalarni qo'llab-quvvatlaydi
  // (masalan Dashboard'dagi Umami "Sozlash" havolasi).
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialTab: TabValue = TABS.some((t) => t.value === tabParam) ? (tabParam as TabValue) : "umumiy";
  const [activeTab, setActiveTab] = useState<TabValue>(initialTab);
  const statuses = integrationStatuses(integrations);

  // Mobil gorizontal lentada faol tab har doim ko'rinib tursin — chetga suzib
  // ketmasin. Faqat mobil (`md:hidden`) tugmalarga ref beramiz; desktop rail'dagi
  // TabsTrigger'lar ref olmagani uchun bu yerda ta'sirlanmaydi.
  const mobileTabRefs = useRef<Partial<Record<TabValue, HTMLButtonElement | null>>>({});
  useEffect(() => {
    const el = mobileTabRefs.current[activeTab];
    if (el && el.offsetParent !== null) {
      el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [activeTab]);

  async function saveSection<K extends SettingsSection | "general">(
    section: K,
    patch: K extends "telegram"
      ? TelegramSettingsPatch
      : K extends "telegraph"
        ? TelegraphSettingsPatch
        : K extends "turnstile"
          ? TurnstileSettingsPatch
          : K extends "r2"
            ? R2SettingsPatch
            : K extends "umami"
              ? UmamiSettingsPatch
              : K extends "github"
                ? GithubSettingsPatch
                : GeneralSettingsPatch,
  ): Promise<void> {
    const fresh = await adminApi.updateSettings({ [section]: patch });
    setIntegrations(fresh);
  }

  async function testSection(section: SettingsSection): Promise<SettingsTestResult> {
    try {
      return await adminApi.testSettingsSection(section);
    } catch (error) {
      return { ok: false, message: error instanceof AdminApiError ? error.message : "Tekshirib bo'lmadi" };
    }
  }

  async function refreshTelegramStatus(): Promise<void> {
    try {
      setTelegramStatus(await adminApi.getTelegramStatus());
    } catch {
      // holat yangilanmasa ham sahifa ishlashda davom etadi
    }
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as TabValue)}
      orientation="vertical"
      className="flex-col items-stretch gap-4 md:flex-row md:items-start"
    >
      {/* Mobil: gorizontal skroll qilinadigan segmentlangan lenta, guruh nomlari bilan */}
      <div
        className="no-scrollbar flex min-w-0 snap-x snap-mandatory items-center gap-1.5 overflow-x-auto rounded-lg bg-muted p-1 md:hidden"
        role="presentation"
      >
        {TAB_GROUPS.map((group, groupIndex) => (
          <div key={group.label} className="flex shrink-0 items-center gap-1.5">
            {groupIndex > 0 ? <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" /> : null}
            <span className="shrink-0 px-1 text-[0.65rem] font-semibold tracking-wide text-muted-foreground uppercase">
              {group.label}
            </span>
            {group.tabs.map((tab) => {
              const status = statuses[tab.value];
              const active = activeTab === tab.value;
              return (
                <button
                  key={tab.value}
                  ref={(el) => {
                    mobileTabRefs.current[tab.value] = el;
                  }}
                  type="button"
                  onClick={() => setActiveTab(tab.value)}
                  aria-current={active}
                  className={cn(
                    "flex min-h-11 shrink-0 snap-center items-center gap-1.5 rounded-md px-3.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {status ? <StatusDot status={status} /> : null}
                  {tab.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Desktop: chapga yopishgan (sticky) tab panel */}
      <div className="hidden md:block md:w-48 md:shrink-0">
        <div className="sticky top-6 flex flex-col gap-4">
          {TAB_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              <p className="px-2 text-[0.7rem] font-semibold tracking-wide text-muted-foreground uppercase">
                {group.label}
              </p>
              <TabsList variant="line" className="h-auto w-full flex-col items-stretch gap-0.5">
                {group.tabs.map((tab) => {
                  const status = statuses[tab.value];
                  return (
                    <TabsTrigger key={tab.value} value={tab.value} className="justify-start gap-2 px-2 py-1.5">
                      {status ? <StatusDot status={status} /> : null}
                      {tab.label}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <TabsContent value="umumiy" className="flex flex-col gap-4">
          <GeneralSection admin={integrations.general} onSave={(patch) => saveSection("general", patch)} />
          <DefaultPostSettingsCard initial={initial.defaultPostSettings} />
        </TabsContent>

        <TabsContent value="haqida">
          <AboutTab initial={initial.about} />
        </TabsContent>

        <TabsContent value="ijtimoiy">
          <SocialTab initial={initial.social} />
        </TabsContent>

        <TabsContent value="telegram">
          <TelegramSection
            admin={integrations.telegram}
            telegramStatus={telegramStatus}
            onSave={(patch) => saveSection("telegram", patch)}
            onTest={() => testSection("telegram")}
            onRefreshStatus={() => void refreshTelegramStatus()}
          />
        </TabsContent>

        <TabsContent value="telegraph">
          <TelegraphSection
            admin={integrations.telegraph}
            onSave={(patch) => saveSection("telegraph", patch)}
            onTest={() => testSection("telegraph")}
          />
        </TabsContent>

        <TabsContent value="turnstile">
          <TurnstileSection
            admin={integrations.turnstile}
            onSave={(patch) => saveSection("turnstile", patch)}
            onTest={() => testSection("turnstile")}
          />
        </TabsContent>

        <TabsContent value="r2">
          <R2Section admin={integrations.r2} onSave={(patch) => saveSection("r2", patch)} onTest={() => testSection("r2")} />
        </TabsContent>

        <TabsContent value="umami">
          <UmamiSection
            admin={integrations.umami}
            onSave={(patch) => saveSection("umami", patch)}
            onTest={() => testSection("umami")}
          />
        </TabsContent>

        <TabsContent value="github">
          <GithubSection
            admin={integrations.github}
            onSave={(patch) => saveSection("github", patch)}
            onTest={() => testSection("github")}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}
