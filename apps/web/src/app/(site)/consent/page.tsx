"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { MCP_REQUIRED_SCOPE_ID, MCP_SCOPE_GROUP_LABELS, type McpScopeGroup } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";
import {
  consentRedirectUrl,
  consentViewState,
  defaultScopeSelection,
  displayClientName,
  hasDangerSelected,
  hasSensitiveSelected,
  isReadOnlySelection,
  rawOAuthQuery,
  registeredAgo,
  serializeScopeSelection,
  toggleScope,
  type ConsentViewState,
} from "@/lib/oauth-flow";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

const GROUP_TONE: Record<McpScopeGroup, string> = {
  read: "border-border",
  write: "border-border",
  publish: "border-amber-500/40 bg-amber-500/5",
  danger: "border-destructive/40 bg-destructive/5",
};

function Shell({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">{icon}</span>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
      <Link
        href="/"
        className="mx-auto flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Saytga qaytish ({site.name})
      </Link>
    </div>
  );
}

function Message({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6 text-sm">
        <p role="status">{text}</p>
        {action}
      </CardContent>
    </Card>
  );
}

export default function ConsentPage() {
  const [view, setView] = useState<ConsentViewState | null>(null);
  const [busy, setBusy] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    const search = window.location.search;
    const query = rawOAuthQuery(search);
    let cancelled = false;

    async function load() {
      let response: { status: number; body: unknown } | null = null;
      try {
        const res = await fetch(`${site.apiUrl}/connector/consent?oauth_query=${encodeURIComponent(query)}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        response = { status: res.status, body: await res.json().catch(() => null) };
      } catch {
        response = null;
      }
      if (cancelled) return;
      const next = consentViewState(search, response);
      setView(next);
      if (next.kind === "ready") setSelected(defaultScopeSelection(next.info.scopes));
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function respond(accept: boolean, requested?: readonly string[]) {
    setBusy(accept ? "accept" : "deny");
    setError(null);
    const { data, error: requestError } = await authClient.$fetch<{ url?: string }>("/oauth2/consent", {
      method: "POST",
      body: {
        accept,
        oauth_query: rawOAuthQuery(window.location.search),
        ...(accept && requested ? { scope: serializeScopeSelection(selected, requested) } : {}),
      },
    });
    const url = consentRedirectUrl(data);
    if (requestError || !url) {
      setBusy(null);
      setError(
        requestError?.status === 403
          ? "Faqat blog egasi (admin) ilovani ulay oladi."
          : "Amalni bajarib bo'lmadi. Havola eskirgan bo'lishi mumkin — Claude'dan ulanishni qaytadan boshlang.",
      );
      return;
    }
    window.location.href = url;
  }

  if (!view) {
    return (
      <Shell title="Ilovani ulash" icon={<KeyRound className="size-5" aria-hidden="true" />}>
        <Message text="Yuklanmoqda…" />
      </Shell>
    );
  }

  const key = (icon: React.ReactNode, title: string, subtitle?: string) => ({ icon, title, subtitle });

  switch (view.kind) {
    case "invalid-link":
      return (
        <Shell {...key(<ShieldAlert className="size-5" />, "Havola yaroqsiz")}>
          <Message text="Bu sahifa faqat Claude (yoki boshqa ilova) ulanishni boshlaganda ochiladi. Ulanishni ilova ichidan boshlang." />
        </Shell>
      );
    case "expired":
      return (
        <Shell {...key(<ShieldAlert className="size-5" />, "Havola eskirgan")}>
          <Message text="So'rov muddati tugagan yoki o'zgartirilgan. Claude'da ulanishni qaytadan boshlang (Customize → Connectors → ulanishni qayta urinib ko'ring)." />
        </Shell>
      );
    case "signed-out":
      return (
        <Shell {...key(<ShieldAlert className="size-5" />, "Avval tizimga kiring")}>
          <Message
            text="Sessiyangiz topilmadi. Claude'da ulanishni qaytadan boshlang — kirish sahifasi o'zi ochiladi."
            action={
              <Button asChild variant="outline">
                <Link href="/login">Kirish sahifasi</Link>
              </Button>
            }
          />
        </Shell>
      );
    case "unavailable":
      return (
        <Shell {...key(<ShieldAlert className="size-5" />, "Server javob bermadi")}>
          <Message text="Ma'lumotni olib bo'lmadi. Birozdan keyin Claude'dan ulanishni qayta boshlang." />
        </Shell>
      );
    case "unknown-client":
      return (
        <Shell {...key(<ShieldAlert className="size-5" />, "Ilova topilmadi")}>
          <Message text="Bu ilova ro'yxatdan o'tmagan yoki o'chirib qo'yilgan. Ulanishni Claude'dan qaytadan boshlang." />
        </Shell>
      );
    case "refused":
      return (
        <Shell {...key(<ShieldAlert className="size-5" />, "Ruxsat berilmaydi", `${view.info.user.email} (${view.info.user.role})`)}>
          <Message
            text="Blogni Claude'ga faqat blog egasi (admin) ulay oladi. Xodimlar va oddiy foydalanuvchilar bu amalni bajara olmaydi. Agar siz egasi bo'lsangiz — admin hisobingiz bilan kirib, ulanishni qaytadan boshlang."
            action={
              <Button type="button" variant="outline" className="max-sm:min-h-11" disabled={busy !== null} onClick={() => void respond(false)}>
                {busy ? "Yuborilmoqda…" : "Ulanishni bekor qilish"}
              </Button>
            }
          />
          {error ? (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </Shell>
      );
    case "ready": {
      const name = displayClientName(view.info.client?.name);
      const host = view.info.client?.redirectHost;
      const kind = view.info.client?.redirectKind ?? "other";
      const ago = registeredAgo(view.info.client?.registeredAt);
      const readOnly = isReadOnlySelection(selected);
      const dangerOn = hasDangerSelected(selected);
      const sensitiveOn = hasSensitiveSelected(selected);
      return (
        <Shell {...key(<ShieldCheck className="size-5" aria-hidden="true" />, "Ilovani blogingizga ulash")}>
          <Card>
            <CardContent className="flex flex-col gap-5 pt-6">
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                <p className="text-xs text-muted-foreground">Ilova o&apos;zini shunday atadi (tasdiqlanmagan — istalgan kishi istalgan nom qo&apos;yishi mumkin):</p>
                <p className="mt-1 break-words text-base font-semibold">{name}</p>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">Kod yuboriladi</dt>
                  <dd className="min-w-0 break-words">
                    <span
                      className={cn(
                        "inline-flex items-center rounded px-1.5 py-0.5 font-medium",
                        kind === "claude" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
                        kind === "loopback" && "bg-sky-500/15 text-sky-700 dark:text-sky-400",
                        kind === "other" && "bg-destructive/15 text-destructive",
                      )}
                    >
                      {host ?? "noma'lum manzil"}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      {kind === "claude" ? "— Claude'ning rasmiy manzili" : kind === "loopback" ? "— shu kompyuterning o'zi (Claude Code)" : "— Claude manzili EMAS"}
                    </span>
                  </dd>
                  <dt className="text-muted-foreground">Ro&apos;yxatdan o&apos;tgan</dt>
                  <dd>{ago ?? "noma'lum"}</dd>
                </dl>
              </div>

              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                Faqat <span className="font-medium">o&apos;zingiz hozirgina</span> o&apos;z Claude&apos;ingizdan ulanishni boshlagan bo&apos;lsangina ruxsat bering. Boshqa
                holatda — <span className="font-medium">Rad etish</span>.
              </p>

              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{view.info.user.email}</span> sifatida ruxsat berasiz. Kerakli ruxsatlarni tanlang — belgilanmaganini ilova qila olmaydi:
              </p>

              <div className="flex flex-col gap-3">
                {view.groups.map((group) => (
                  <fieldset key={group.group} className={cn("rounded-lg border p-3", GROUP_TONE[group.group])}>
                    <legend className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.group === "danger" ? <ShieldAlert className="size-3.5 text-destructive" aria-hidden="true" /> : null}
                      {MCP_SCOPE_GROUP_LABELS[group.group]}
                    </legend>
                    <ul className="flex flex-col">
                      {group.scopes.map((scope) => {
                        const required = scope.id === MCP_REQUIRED_SCOPE_ID;
                        const inputId = `scope-${scope.id.replace(/[^a-z0-9]/gi, "-")}`;
                        return (
                          <li key={scope.id}>
                            <label htmlFor={inputId} className={cn("flex min-h-11 items-start gap-3 rounded-md py-2 text-sm", required ? "cursor-default" : "cursor-pointer")}>
                              <input
                                id={inputId}
                                type="checkbox"
                                className={cn("mt-0.5 size-5 shrink-0 rounded border-border", group.group === "danger" ? "accent-red-600" : "accent-primary")}
                                checked={selected.includes(scope.id)}
                                disabled={required || busy !== null}
                                aria-describedby={`${inputId}-desc`}
                                onChange={() => setSelected((current) => toggleScope(current, scope.id, view.info.scopes))}
                              />
                              <span>
                                <span className="font-medium">{scope.label}</span>
                                {required ? <span className="ml-2 text-xs text-muted-foreground">(doim yoqilgan)</span> : null}
                                <span id={`${inputId}-desc`} className="block text-xs text-muted-foreground">
                                  {scope.description}
                                </span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                ))}
              </div>

              {readOnly ? (
                <p className="text-sm font-medium">
                  Bu ulanish faqat O&apos;QIY oladi: hech narsani yozolmaydi, o&apos;zgartira, chop eta yoki o&apos;chira olmaydi.
                </p>
              ) : null}
              {view.offline ? (
                <p className="text-xs text-muted-foreground">
                  Ulanish qayta kirmasdan saqlanib turadi. Istalgan payt Admin → Ulangan ilovalar bo&apos;limidan uzishingiz mumkin.
                </p>
              ) : null}
              {view.unknown.length > 0 ? (
                <p role="alert" className="text-xs text-destructive">
                  Noma&apos;lum ruxsatlar so&apos;ralgan: {view.unknown.join(", ")}. Ular berilmaydi.
                </p>
              ) : null}
              {dangerOn ? (
                <p className="text-xs text-destructive">
                  Diqqat: bu ilova postlarni o&apos;chira olishi yoki izohlarni boshqarishi mumkin. Faqat ishonchli ilovaga ruxsat bering.
                </p>
              ) : null}
              {sensitiveOn ? (
                <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                  Juda muhim: xodim taklif havolasi parol kabi — uni ochgan kishi xodim bo&apos;ladi; sayt sozlamalari esa ochiq saytni darhol o&apos;zgartiradi.
                  Bu ruxsatlarni faqat ishonchli ilovaga va faqat kerak bo&apos;lganda bering. Kalit va parollarga ilova baribir yetmaydi.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" className="max-sm:min-h-11" disabled={busy !== null} onClick={() => void respond(false)}>
                  {busy === "deny" ? "Yuborilmoqda…" : "Rad etish"}
                </Button>
                <Button type="button" className="max-sm:min-h-11" disabled={busy !== null} onClick={() => void respond(true, view.info.scopes)}>
                  {busy === "accept" ? "Ulanmoqda…" : "Ruxsat berish"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </Shell>
      );
    }
  }
}
