"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PasswordInput } from "@/components/auth/password-input";
import { authClient } from "@/lib/auth-client";
import { NEW_PASSWORD_MIN } from "@/lib/password-change";
import {
  FORGOT_PAGE_PATH,
  RESET_PAGE_PATH,
  describeLinkState,
  describeResetFailure,
  parseResetLocation,
  validatePasswordReset,
  type PasswordResetErrors,
  type ResetLinkState,
} from "@/lib/password-reset";

/**
 * Manzildagi token/xato BIR MARTA o'qiladi va manzil satridan darhol olib tashlanadi (tarix yozuvi, ekran, nusxa).
 * Token modul o'zgaruvchisida (React state'ida emas, localStorage'da emas) saqlanadi va sahifa yangilansa yo'qoladi.
 * `getSnapshot` idempotent: birinchi chaqiruvda o'qiydi va tozalaydi, keyingilari keshdan qaytaradi.
 */
let captured: ResetLinkState | null = null;

function captureFromLocation(): ResetLinkState {
  if (captured === null) {
    captured = parseResetLocation(window.location.search);
    if (window.location.search || window.location.hash) window.history.replaceState(null, "", RESET_PAGE_PATH);
  }
  return captured;
}

const subscribe = () => () => undefined;
const SERVER_SNAPSHOT = null;

const REDIRECT_AFTER_MS = 5000;

export function ResetPasswordForm() {
  const router = useRouter();
  const link = useSyncExternalStore(subscribe, captureFromLocation, () => SERVER_SNAPSHOT);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<PasswordResetErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [linkDead, setLinkDead] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const retryAfterRef = useRef<string | null>(null);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => router.push("/login"), REDIRECT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [done, router]);

  if (link === null) {
    // Server renderi / gidratsiyadan oldin: bo'sh karta (token hali o'qilmagan).
    return <Card aria-busy="true"><CardContent className="h-40" /></Card>;
  }

  if (done) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <p role="status" className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span>
              <strong className="font-medium">Parol yangilandi.</strong> Barcha qurilmalardagi sessiyalar tugatildi.
              Endi yangi parol bilan kiring.
            </span>
          </p>
          <Button asChild>
            <Link href="/login">Kirish sahifasiga o&apos;tish</Link>
          </Button>
          <p className="text-center text-xs text-muted-foreground">Bir necha soniyadan keyin avtomatik o&apos;tasiz.</p>
        </CardContent>
      </Card>
    );
  }

  if (link.kind !== "ready" || linkDead) {
    const view = linkDead || link.kind === "ready" ? describeLinkState({ kind: "invalid" }) : describeLinkState(link);
    const retryable = link.kind === "rate_limited" && !linkDead;
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div role="alert" className="flex items-start gap-2">
            <LinkIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-medium">{view.title}</h2>
              <p className="text-sm text-muted-foreground">{view.message}</p>
            </div>
          </div>
          {retryable ? null : (
            <Button asChild variant="outline">
              <Link href={FORGOT_PAGE_PATH}>Yangi havola so&apos;rash</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const token = link.token;

  function clearField(field: keyof PasswordResetErrors) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setFormError(null);

    const fieldErrors = validatePasswordReset({ newPassword, confirmPassword });
    setErrors(fieldErrors);
    const firstInvalid = (["newPassword", "confirmPassword"] as const).find((f) => fieldErrors[f]);
    if (firstInvalid) {
      requestAnimationFrame(() => document.getElementById(firstInvalid === "newPassword" ? "reset-new-password" : "reset-confirm-password")?.focus());
      return;
    }

    setSaving(true);
    retryAfterRef.current = null;
    let failure: { status?: number; code?: string } | null = null;
    try {
      const { error } = await authClient.resetPassword({
        newPassword,
        token,
        fetchOptions: {
          onError: (ctx) => {
            retryAfterRef.current = ctx.response.headers.get("Retry-After") ?? ctx.response.headers.get("X-Retry-After");
          },
        },
      });
      if (error) failure = { status: error.status, code: error.code };
    } catch {
      failure = {};
    }
    setSaving(false);

    if (failure) {
      const view = describeResetFailure({ ...failure, retryAfter: retryAfterRef.current });
      if (view.linkInvalid) {
        setLinkDead(true);
        setNewPassword("");
        setConfirmPassword("");
        return;
      }
      if (view.field) setErrors({ [view.field]: view.message });
      else setFormError(view.message);
      return;
    }

    // Muvaffaqiyat: parollar xotiradan darhol tozalanadi.
    setNewPassword("");
    setConfirmPassword("");
    setErrors({});
    setDone(true);
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <PasswordInput
            id="reset-new-password"
            label="Yangi parol"
            value={newPassword}
            onChange={(v) => {
              setNewPassword(v);
              clearField("newPassword");
            }}
            error={errors.newPassword}
            hint={`Kamida ${NEW_PASSWORD_MIN} ta belgi.`}
            disabled={saving}
            autoFocus
          />
          <PasswordInput
            id="reset-confirm-password"
            label="Yangi parolni takrorlang"
            value={confirmPassword}
            onChange={(v) => {
              setConfirmPassword(v);
              clearField("confirmPassword");
            }}
            error={errors.confirmPassword}
            disabled={saving}
          />

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <Button type="submit" disabled={saving}>
            {saving ? "Saqlanmoqda…" : "Parolni o'rnatish"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Parol o&apos;rnatilgach barcha qurilmalardagi sessiyalar tugatiladi.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
