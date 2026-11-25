"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { authClient } from "@/lib/auth-client";
import {
  NEW_PASSWORD_MIN,
  describeChangePasswordFailure,
  validatePasswordChange,
  type PasswordChangeErrors,
  type PasswordChangeField,
} from "@/lib/password-change";

const FIELD_IDS: Record<PasswordChangeField, string> = {
  currentPassword: "current-password",
  newPassword: "new-password",
  confirmPassword: "confirm-password",
};

function PasswordField({
  field,
  label,
  autoComplete,
  value,
  onChange,
  error,
  hint,
  disabled,
}: {
  field: PasswordChangeField;
  label: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const id = FIELD_IDS[field];
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `${label}ni yashirish` : `${label}ni ko'rsatish`}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
        </button>
      </div>
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ChangePasswordForm({ email }: { email: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [errors, setErrors] = useState<PasswordChangeErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [success, setSuccess] = useState<{ revoked: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  // Faqat `onError` ichida o'qiladi — parol emas, header qiymati.
  const retryAfterRef = useRef<string | null>(null);

  function setField(field: PasswordChangeField, value: string) {
    if (field === "currentPassword") setCurrentPassword(value);
    if (field === "newPassword") setNewPassword(value);
    if (field === "confirmPassword") setConfirmPassword(value);
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setFormError(null);
    setSuccess(null);
  }

  function focusField(field: PasswordChangeField) {
    requestAnimationFrame(() => document.getElementById(FIELD_IDS[field])?.focus());
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setFormError(null);
    setSuccess(null);
    setSessionExpired(false);

    const fieldErrors = validatePasswordChange({ currentPassword, newPassword, confirmPassword });
    const firstInvalid = (["currentPassword", "newPassword", "confirmPassword"] as const).find((f) => fieldErrors[f]);
    setErrors(fieldErrors);
    if (firstInvalid) {
      focusField(firstInvalid);
      return;
    }

    setSaving(true);
    retryAfterRef.current = null;
    let failure: { status?: number; code?: string } | null = null;
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions,
        fetchOptions: {
          onError: (ctx) => {
            retryAfterRef.current = ctx.response.headers.get("Retry-After") ?? ctx.response.headers.get("X-Retry-After");
          },
        },
      });
      if (error) failure = { status: error.status, code: error.code };
    } catch {
      // Tarmoq xatosi (fetch otib yubordi) — status yo'q.
      failure = {};
    }
    setSaving(false);

    if (failure) {
      const view = describeChangePasswordFailure({ ...failure, retryAfter: retryAfterRef.current });
      setSessionExpired(failure.status === 401);
      if (view.field) {
        setErrors({ [view.field]: view.message });
        if (view.field === "currentPassword") setCurrentPassword("");
        focusField(view.field);
      } else {
        setFormError(view.message);
      }
      return;
    }

    // Muvaffaqiyat: parollar xotiradan darhol tozalanadi.
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setErrors({});
    setSuccess({ revoked: revokeOtherSessions });
    toast.success("Parol almashtirildi");
  }

  return (
    <Card className="max-w-xl">
      <form onSubmit={handleSubmit} noValidate>
        <CardHeader className="flex flex-col gap-1">
          <CardTitle>Parolni almashtirish</CardTitle>
          <CardDescription>Faqat o&apos;z hisobingiz uchun. Avval joriy parolingizni tasdiqlashingiz kerak.</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-email">Email</Label>
            {/* Brauzer/parol menejeri "username" sifatida taniydi; faqat o'qish uchun. */}
            <Input
              id="account-email"
              name="username"
              type="email"
              autoComplete="username"
              value={email}
              readOnly
              className="text-muted-foreground"
            />
          </div>

          <PasswordField
            field="currentPassword"
            label="Joriy parol"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(v) => setField("currentPassword", v)}
            error={errors.currentPassword}
            disabled={saving}
          />
          <PasswordField
            field="newPassword"
            label="Yangi parol"
            autoComplete="new-password"
            value={newPassword}
            onChange={(v) => setField("newPassword", v)}
            error={errors.newPassword}
            hint={`Kamida ${NEW_PASSWORD_MIN} ta belgi.`}
            disabled={saving}
          />
          <PasswordField
            field="confirmPassword"
            label="Yangi parolni takrorlang"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(v) => setField("confirmPassword", v)}
            error={errors.confirmPassword}
            disabled={saving}
          />

          <div className="flex items-center justify-between gap-3 py-1">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="revoke-other-sessions">Boshqa qurilmalardan chiqarish</Label>
              <p className="text-xs text-muted-foreground">
                Boshqa brauzer va qurilmalardagi sessiyalar tugatiladi. Bu qurilmada kirgan holatda qolasiz.
              </p>
            </div>
            <Switch
              id="revoke-other-sessions"
              checked={revokeOtherSessions}
              onCheckedChange={setRevokeOtherSessions}
              disabled={saving}
            />
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}{" "}
              {sessionExpired ? (
                <Link href="/login" className="underline underline-offset-2">
                  Kirish sahifasi
                </Link>
              ) : null}
            </p>
          ) : null}

          {success ? (
            <p role="status" className="flex items-start gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                Parol almashtirildi.{" "}
                {success.revoked ? "Boshqa qurilmalardagi sessiyalar tugatildi." : "Boshqa qurilmalardagi sessiyalar saqlanib qoldi."}
              </span>
            </p>
          ) : null}
        </CardContent>

        <CardFooter className="border-t border-border pt-4">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saqlanmoqda…" : "Parolni almashtirish"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
