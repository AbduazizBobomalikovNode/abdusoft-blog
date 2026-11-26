"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { DistributionProviderSettingsDto, DistributionSettingsResponse } from "@blog/shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { NO_AUTO_POST_NOTICE, TONE_CLASS, tokenLine } from "@/lib/distribution-ui";
import { formatDate } from "@/lib/format";
import { cn } from "cn";
import { SecretFieldRow, TextFieldRow } from "./field-row";

function msg(e: unknown, fallback: string): string {
  return e instanceof AdminApiError ? e.message : fallback;
}

export function CopyButton({ value, label = "Nusxa" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error("Nusxalab bo'lmadi — qo'lda belgilab oling");
    }
  }
  return (
    <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void copy()} aria-label="Redirect URL'ni nusxalash">
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? "Nusxalandi" : label}
    </Button>
  );
}

function ProviderCard({ p, onChanged }: { p: DistributionProviderSettingsDto; onChanged: (v: DistributionSettingsResponse) => void }) {
  const [clientId, setClientId] = useState(p.credentials?.clientId.value ?? "");
  const [secretDraft, setSecretDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const line = tokenLine(p.account);
  const oauth = p.authKind !== "pasted_token";
  const creds = p.credentials;

  async function saveCreds() {
    if (!creds || p.id === "github") return;
    setSaving(true);
    try {
      const patch: { clientId?: string; clientSecret?: string } = {};
      if (creds.clientId.source !== "env") patch.clientId = clientId;
      if (secretDraft !== undefined) patch.clientSecret = secretDraft;
      onChanged(await adminApi.saveDistributionCredentials({ [p.id]: patch }));
      setSecretDraft(undefined);
      toast.success(`${p.name}: kalitlar saqlandi`);
    } catch (e) {
      toast.error(msg(e, "Saqlab bo'lmadi"));
    } finally {
      setSaving(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const r = await adminApi.distributionConnect(p.id);
      window.location.assign(r.authorizationUrl);
    } catch (e) {
      toast.error(msg(e, "Ulanishni boshlab bo'lmadi"));
      setBusy(false);
    }
  }

  async function pasteToken() {
    setBusy(true);
    try {
      await adminApi.distributionPasteToken(p.id, token.trim());
      setToken("");
      onChanged(await adminApi.distributionSettings());
      toast.success("GitHub ulandi");
    } catch (e) {
      toast.error(msg(e, "Token qabul qilinmadi"));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await adminApi.distributionDisconnect(p.id);
      onChanged(await adminApi.distributionSettings());
      toast.success(`${p.name} uzildi — tokenlar o'chirildi`);
    } catch (e) {
      toast.error(msg(e, "Uzib bo'lmadi"));
    } finally {
      setBusy(false);
      setConfirmOff(false);
    }
  }

  return (
    <Card data-testid={`dist-provider-${p.id}`}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">{p.name}</CardTitle>
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", TONE_CLASS[line.tone])}>{p.account ? line.text : "Ulanmagan"}</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {p.account ? (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium break-words">
              {p.account.displayName}
              {p.account.username ? <span className="text-muted-foreground"> @{p.account.username}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">
              Ulangan: {formatDate(p.account.connectedAt)}
              {p.account.expiresAt ? ` · muddat: ${formatDate(p.account.expiresAt)}` : ""}
            </p>
          </div>
        ) : null}

        <details className="rounded-lg border border-border px-3 py-2 text-sm" open={!p.account}>
          <summary className="cursor-pointer font-medium">Platformada nima qilish kerak</summary>
          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-xs text-muted-foreground">
            {p.ownerSetup.map((step) => (
              <li key={step} className="break-words">{step}</li>
            ))}
          </ol>
        </details>

        {p.redirectUrl ? (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Redirect (callback) URL — platformada AYNAN shuni ro&apos;yxatdan o&apos;tkazing</Label>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1.5 text-xs break-all" data-testid={`dist-redirect-${p.id}`}>{p.redirectUrl}</code>
              <CopyButton value={p.redirectUrl} />
            </div>
          </div>
        ) : null}

        {oauth && creds ? (
          <div className="flex flex-col gap-3">
            <TextFieldRow id={`dist-${p.id}-id`} label="Client ID" field={creds.clientId} value={clientId} onChange={setClientId} />
            <SecretFieldRow id={`dist-${p.id}-secret`} label={p.id === "x" ? "Client secret (ixtiyoriy — public client)" : "Client secret"} field={creds.clientSecret} draftValue={secretDraft} onDraftChange={setSecretDraft} />
            <div>
              <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void saveCreds()}>
                {saving ? "Saqlanmoqda…" : "Kalitlarni saqlash"}
              </Button>
            </div>
          </div>
        ) : null}

        {!oauth ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dist-gh-token" className="text-xs text-muted-foreground">Fine-grained token (faqat shu repo, Contents: write)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input id="dist-gh-token" type="password" autoComplete="off" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} className="min-w-0 flex-1" />
              <Button type="button" size="sm" disabled={busy || token.trim().length < 8} onClick={() => void pasteToken()}>
                {p.account ? "Tokenni almashtirish" : "Tekshirib ulash"}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {oauth ? (
            <Button type="button" size="sm" disabled={busy || !p.credentialsReady} onClick={() => void connect()}>
              {p.account ? "Qayta ulash" : "Ulash"}
            </Button>
          ) : null}
          {p.account ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmOff(true)}>
              Uzish
            </Button>
          ) : null}
          {oauth && !p.credentialsReady ? <span className="text-xs text-muted-foreground">Avval Client ID/Secret ni saqlang</span> : null}
        </div>

        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p><span className="font-medium text-foreground">Narx:</span> {p.costNote}</p>
          <p><span className="font-medium text-foreground">Token:</span> {p.tokenLifetime}</p>
          {p.restrictions.map((r) => (
            <p key={r} className="break-words">• {r}</p>
          ))}
          {p.docs[0] ? (
            <a href={p.docs[0]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
              Hujjat <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      </CardContent>

      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{p.name}ni uzish</AlertDialogTitle>
            <AlertDialogDescription>
              Saqlangan tokenlar o&apos;chiriladi. Platformadagi ruxsatni qaytarib olish uchun platforma sozlamalariga kiring (bu yerdan chaqirilmaydi).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction onClick={() => void disconnect()}>Uzish</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** "Tarqatish kanallari" — faqat `DISTRIBUTION_ENABLED=true` bo'lganda render qilinadi (sahifa API 404 bo'lsa uzatmaydi). */
export function DistributionSection({ initial }: { initial: DistributionSettingsResponse }) {
  const [data, setData] = useState(initial);
  const router = useRouter();
  const params = useSearchParams();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const dist = params.get("dist");
    if (!dist) return;
    handled.current = true;
    if (dist === "connected") toast.success(`${params.get("provider") ?? "Akkaunt"} ulandi`);
    else toast.error(params.get("reason") ?? "Ulanish muvaffaqiyatsiz");
    void adminApi.distributionSettings().then(setData).catch(() => undefined);
    router.replace("/admin/sozlamalar?tab=tarqatish");
  }, [params, router]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm" data-testid="dist-no-auto">
        <p className="font-medium">Tarqatish kanallari</p>
        <p className="mt-1 text-xs text-muted-foreground">{NO_AUTO_POST_NOTICE}</p>
        <p className="mt-1 text-xs text-muted-foreground">{data.linkedinTermsNote}</p>
      </div>
      {data.providers.map((p) => (
        <ProviderCard key={`${p.id}-${p.account?.id ?? "none"}-${p.credentialsReady}`} p={p} onChanged={setData} />
      ))}
    </div>
  );
}
