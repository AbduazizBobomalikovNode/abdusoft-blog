"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { MCP_SCOPE_GROUP_LABELS, type McpScopeGroup } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";
import { consentRedirectUrl, consentViewState, rawOAuthQuery, type ConsentViewState } from "@/lib/oauth-flow";
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
      if (!cancelled) setView(consentViewState(search, response));
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function respond(accept: boolean) {
    setBusy(accept ? "accept" : "deny");
    setError(null);
    const { data, error: requestError } = await authClient.$fetch<{ url?: string }>("/oauth2/consent", {
      method: "POST",
      body: { accept, oauth_query: rawOAuthQuery(window.location.search) },
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
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void respond(false)}>
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
      const name = view.info.client?.name ?? "Noma'lum ilova";
      const host = view.info.client?.redirectHost;
      return (
        <Shell
          {...key(
            <ShieldCheck className="size-5" aria-hidden="true" />,
            `${name} blogingizga ulanmoqchi`,
            host ? `Qaytish manzili: ${host}` : undefined,
          )}
        >
          <Card>
            <CardContent className="flex flex-col gap-5 pt-6">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{view.info.user.email}</span> sifatida ruxsat berasiz. Ilova quyidagilarni qila oladi:
              </p>

              <div className="flex flex-col gap-3">
                {view.groups.map((group) => (
                  <section key={group.group} aria-label={group.label} className={cn("rounded-lg border p-3", GROUP_TONE[group.group])}>
                    <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.group === "danger" ? <ShieldAlert className="size-3.5 text-destructive" aria-hidden="true" /> : null}
                      {MCP_SCOPE_GROUP_LABELS[group.group]}
                    </h2>
                    <ul className="flex flex-col gap-2">
                      {group.scopes.map((scope) => (
                        <li key={scope.id} className="flex gap-2 text-sm">
                          <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span>
                            <span className="font-medium">{scope.label}</span>
                            <span className="block text-xs text-muted-foreground">{scope.description}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>

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
              {view.hasDanger ? (
                <p className="text-xs text-destructive">
                  Diqqat: bu ilova postlarni o&apos;chira olishi yoki izohlarni boshqarishi mumkin. Faqat ishonchli ilovaga ruxsat bering.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void respond(false)}>
                  {busy === "deny" ? "Yuborilmoqda…" : "Rad etish"}
                </Button>
                <Button type="button" disabled={busy !== null} onClick={() => void respond(true)}>
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
