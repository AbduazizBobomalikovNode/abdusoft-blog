"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { signIn, useSession } from "@/lib/auth-client";
import { useSiteConfig } from "@/lib/site-config";

/**
 * `/taklif/[token]` sahifasining interaktiv qismi. Oqim:
 * 1. Kirmagan mehmon "GitHub bilan kirish" tugmasini bosadi ->
 *    `callbackURL=/taklif/<token>?accept=1` bilan qaytadi.
 * 2. Shu sahifaga `accept=1` bilan (endi tizimga kirgan holda) qaytgach,
 *    avtomatik `POST /staff/invites/:token/accept` chaqiriladi -> `/admin`ga
 *    yo'naltiriladi.
 */
export function TaklifAcceptClient({ token }: { token: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const config = useSiteConfig();
  const { data: session, isPending } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shouldAutoAccept = searchParams.get("accept") === "1";

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.acceptStaffInvite(token);
      toast.success("Xush kelibsiz! Admin panelga yo'naltirilmoqda…");
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : "Taklifni qabul qilib bo'lmadi");
      setBusy(false);
    }
  }

  useEffect(() => {
    if (isPending || busy || !session || !shouldAutoAccept) return;
    // `accept()` sets state synchronously (setBusy) as its first statement —
    // deferred to a microtask so it isn't called directly from the effect body.
    queueMicrotask(() => void accept());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPending, session, shouldAutoAccept]);

  if (!config.githubConfigured) {
    return (
      <p className="text-sm text-muted-foreground">
        GitHub integratsiyasi hali sozlanmagan — admin bilan bog&apos;laning.
      </p>
    );
  }

  if (isPending || busy) {
    return <p className="text-sm text-muted-foreground">Yuklanmoqda…</p>;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button variant="outline" onClick={() => void accept()}>
          Qayta urinish
        </Button>
      </div>
    );
  }

  if (session) {
    return (
      <Button onClick={() => void accept()} disabled={busy}>
        Taklifni qabul qilish
      </Button>
    );
  }

  return (
    <Button onClick={() => void signIn.social({ provider: "github", callbackURL: `/taklif/${token}?accept=1` })}>
      GitHub bilan kirish
    </Button>
  );
}
