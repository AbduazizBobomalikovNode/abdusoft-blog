"use client";

import type { AdminPostStatus, ChannelPlan, PostSettings, TagWithCount, TelegramRef } from "@blog/shared";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { SETTING_SWITCHES } from "@/components/admin/post-settings-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import { ChannelPlanFields } from "./channel-plan-fields";
import { CoverImagePicker } from "./cover-image-picker";
import { TagMultiselect } from "./tag-multiselect";

// "Interaktivlik" kartasida ko'rsatiladigan sozlamalar — Telegram bilan bog'liq
// ikkitasi ("telegraphMirror", "channelAutoPost") alohida "Telegram" kartasiga chiqadi.
const INTERACTIVITY_KEYS: (keyof PostSettings)[] = [
  "commentsEnabled",
  "reactionsEnabled",
  "showDislike",
  "showViews",
  "showToc",
  "allowAnonymousComments",
  "commentsRequireApproval",
];
// `channelAutoPost` orqaga moslik uchun sxemada qolgan, lekin ENDI ISHLATILMAYDI
// (kanalga yuborish butunlay qo'lda — "Kanalga yuborish" dialogi) — shu sabab UI'da
// ko'rsatilmaydi.
const TELEGRAM_SETTING_KEYS: (keyof PostSettings)[] = ["telegraphMirror"];

export interface PostEditorSettingsProps {
  allTags: TagWithCount[];
  selectedTagSlugs: string[];
  onTagsChange: (slugs: string[]) => void;
  settings: PostSettings;
  onSettingsChange: (patch: Partial<PostSettings>) => void;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  excerpt: string;
  onExcerptChange: (value: string) => void;
  onExcerptAuto: () => void;
  coverUrl: string | null;
  onCoverChange: (url: string | null) => void;
  scheduledAtLocal: string;
  onScheduledAtLocalChange: (value: string) => void;
  onSchedule: () => void;
  scheduling: boolean;
  /** Postning ID'si — kanal rejasining oldindan ko'rinishi uchun. */
  postId?: string;
  /** Rejalashtirish bilan birga kanalga yuborish rejasi (`null` — yuborilmaydi). */
  channelPlan?: ChannelPlan | null;
  onChannelPlanChange?: (plan: ChannelPlan | null) => void;
  /** Kanal rejasida Telegram cheklovi xatolari bor bo'lsa `true` — "Rejalashtirish" o'chiriladi. */
  onChannelPlanBlockingChange?: (blocked: boolean) => void;
  channelPlanBlocked?: boolean;
  /** "Rejani bekor qilish" — rejalashtirilgan postni qoralamaga qaytaradi (kanal rejasi ham o'chadi). */
  onCancelSchedule?: () => void;
  telegram: TelegramRef | null;
  channelUrl: string | null;
  onRefreshTelegraph: () => void;
  refreshingTelegraph: boolean;
  onOpenChannelSend: () => void;
  /** "Nashr" kartasi uchun — ixtiyoriy, berilmasa status/sana bloki ko'rsatilmaydi. */
  status?: AdminPostStatus;
  publishedAt?: string | null;
  updatedAt?: string;
}

function SettingsCard({
  title,
  hint,
  extra,
  children,
}: {
  title: string;
  hint: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="gap-0.5 px-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          {extra}
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">{children}</CardContent>
    </Card>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <Label htmlFor={id} className="min-h-11 min-w-0 flex-1 cursor-pointer flex-col items-start justify-center gap-0.5 leading-snug">
        <span>{label}</span>
        <span className="text-xs font-normal text-muted-foreground">{hint}</span>
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="max-md:after:-inset-x-4 max-md:after:-inset-y-3.5" />
    </div>
  );
}

export function PostEditorSettings({
  allTags,
  selectedTagSlugs,
  onTagsChange,
  settings,
  onSettingsChange,
  pinned,
  onPinnedChange,
  excerpt,
  onExcerptChange,
  onExcerptAuto,
  coverUrl,
  onCoverChange,
  scheduledAtLocal,
  onScheduledAtLocalChange,
  onSchedule,
  scheduling,
  postId,
  channelPlan = null,
  onChannelPlanChange,
  onChannelPlanBlockingChange,
  channelPlanBlocked = false,
  onCancelSchedule,
  telegram,
  channelUrl,
  onRefreshTelegraph,
  refreshingTelegraph,
  onOpenChannelSend,
  status,
  publishedAt,
  updatedAt,
}: PostEditorSettingsProps) {
  const interactivitySwitches = SETTING_SWITCHES.filter((item) => INTERACTIVITY_KEYS.includes(item.key));
  const telegramSwitches = SETTING_SWITCHES.filter((item) => TELEGRAM_SETTING_KEYS.includes(item.key));

  return (
    <div className="flex flex-col gap-4">
      {status ? (
        <SettingsCard title="Nashr" hint="Holat, sana va rejalashtirish" extra={<PostStatusBadge status={status} />}>
          <p className="text-xs text-muted-foreground">
            {status === "published" && publishedAt
              ? `Chop etilgan: ${formatDateTime(publishedAt)}`
              : status === "scheduled"
                ? "Rejalashtirilgan sana pastda ko'rsatilgan"
                : updatedAt
                  ? `Oxirgi o'zgarish: ${formatDateTime(updatedAt)}`
                  : null}
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="post-schedule">Rejalashtirish</Label>
            <p className="text-xs text-muted-foreground">Belgilangan vaqtda post avtomatik chop etiladi.</p>
            <div className="flex flex-wrap gap-2">
              <Input
                id="post-schedule"
                type="datetime-local"
                value={scheduledAtLocal}
                onChange={(event) => onScheduledAtLocalChange(event.target.value)}
                className="w-fit max-md:h-11 max-md:w-full"
              />
              <Button type="button" variant="outline" size="sm" className="max-md:h-11 max-md:flex-1" disabled={scheduling || !scheduledAtLocal || (channelPlan !== null && channelPlanBlocked)} onClick={onSchedule}>
                {scheduling ? "Yuborilmoqda…" : status === "scheduled" ? "Qayta rejalashtirish" : "Rejalashtirish"}
              </Button>
              {status === "scheduled" && onCancelSchedule ? (
                <Button type="button" variant="ghost" size="sm" className="max-md:h-11 max-md:flex-1" onClick={onCancelSchedule}>
                  Rejani bekor qilish
                </Button>
              ) : null}
            </div>
            {postId && onChannelPlanChange ? (
              <ChannelPlanFields
                postId={postId}
                value={channelPlan}
                onChange={onChannelPlanChange}
                scheduledAtLocal={scheduledAtLocal}
                onBlockingChange={onChannelPlanBlockingChange}
              />
            ) : null}
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard title="Ko'rinish" hint="Muqova, qisqacha tavsif, teglar va muhimlik">
        <div className="flex flex-col gap-2">
          <Label>Muqova rasm</Label>
          <CoverImagePicker coverUrl={coverUrl} onChange={onCoverChange} />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="post-excerpt">Qisqacha tavsif</Label>
            <button
              type="button"
              onClick={onExcerptAuto}
              className="-mr-2 rounded px-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11"
            >
              Avtomatik
            </button>
          </div>
          <Textarea
            id="post-excerpt"
            value={excerpt}
            onChange={(event) => onExcerptChange(event.target.value)}
            placeholder="Ro'yxatlarda ko'rinadigan qisqa matn…"
            rows={3}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Teglar</Label>
          <TagMultiselect allTags={allTags} selectedSlugs={selectedTagSlugs} onChange={onTagsChange} />
        </div>

        <SwitchRow
          id="post-pinned"
          label="Muhim (pinned)"
          hint="Ro'yxat boshida ko'rsatiladi"
          checked={pinned}
          onChange={onPinnedChange}
        />
      </SettingsCard>

      <SettingsCard title="Interaktivlik" hint="Izohlar, reaksiyalar va o'quvchiga ko'rinadigan bloklar">
        <div className="flex flex-col divide-y divide-border">
          {interactivitySwitches.map((item) => (
            <div key={item.key} className="py-1 first:pt-0 last:pb-0">
              <SwitchRow
                id={`setting-${item.key}`}
                label={item.label}
                hint={item.hint}
                checked={settings[item.key]}
                onChange={(checked) => onSettingsChange({ [item.key]: checked })}
              />
            </div>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title="Telegram" hint="Ko'zgulash va kanalga avtomatik post">
        <div className="flex flex-col divide-y divide-border">
          {telegramSwitches.map((item) => (
            <div key={item.key} className="py-1 first:pt-0 last:pb-0">
              <SwitchRow
                id={`setting-${item.key}`}
                label={item.label}
                hint={item.hint}
                checked={settings[item.key]}
                onChange={(checked) => onSettingsChange({ [item.key]: checked })}
              />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5">
          {telegram?.telegraphUrl ? (
            <a
              href={telegram.telegraphUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center text-xs text-primary underline underline-offset-2 md:block md:min-h-0"
            >
              <span className="block min-w-0 truncate">{telegram.telegraphUrl}</span>
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">Telegraph nusxa hali yaratilmagan</p>
          )}
          {channelUrl ? (
            <a
              href={channelUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center text-xs text-primary underline underline-offset-2 md:block md:min-h-0"
            >
              <span className="block min-w-0 truncate">Kanaldagi post</span>
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">Kanalga hali yuborilmagan</p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" className="max-md:h-11 max-md:flex-1" disabled={refreshingTelegraph} onClick={onRefreshTelegraph}>
              {refreshingTelegraph ? "Yangilanmoqda…" : "Telegraph'ni yangilash"}
            </Button>
            <Button type="button" variant="outline" size="sm" className="max-md:h-11 max-md:flex-1" onClick={onOpenChannelSend}>
              Kanalga yuborish
            </Button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
