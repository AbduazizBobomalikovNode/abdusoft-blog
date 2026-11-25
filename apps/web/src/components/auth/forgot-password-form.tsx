"use client";

import { useRef, useState, type FormEvent } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import {
  FORGOT_NEUTRAL_MESSAGE,
  FORGOT_STAFF_HINT,
  describeForgotFailure,
  validateForgotEmail,
} from "@/lib/password-reset";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const retryAfterRef = useRef<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);

    const problem = validateForgotEmail(email);
    setFieldError(problem);
    if (problem) return;

    setBusy(true);
    retryAfterRef.current = null;
    let failure: { status?: number } | null = null;
    try {
      const { error } = await authClient.requestPasswordReset({
        email: email.trim(),
        fetchOptions: {
          onError: (ctx) => {
            retryAfterRef.current = ctx.response.headers.get("Retry-After") ?? ctx.response.headers.get("X-Retry-After");
          },
        },
      });
      if (error) failure = { status: error.status };
    } catch {
      failure = {};
    }
    setBusy(false);

    if (failure) {
      setFormError(describeForgotFailure({ ...failure, retryAfter: retryAfterRef.current }));
      return;
    }
    // Har qanday email uchun bir xil javob — hisob bor-yo'qligi ko'rinmaydi.
    setDone(true);
  }

  if (done) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p role="status" className="flex items-start gap-2 text-sm">
            <MailCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span>{FORGOT_NEUTRAL_MESSAGE}</span>
          </p>
          <p className="text-sm text-muted-foreground">{FORGOT_STAFF_HINT}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Admin email manzilingizni kiriting. Tiklash havolasi admin Telegram chatiga yuboriladi.
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="forgot-email">Email</Label>
            <Input
              id="forgot-email"
              name="email"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              inputMode="email"
              required
              autoFocus
              disabled={busy}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? "forgot-email-error" : undefined}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setFieldError(null);
              }}
            />
            {fieldError ? (
              <p id="forgot-email-error" role="alert" className="text-xs text-destructive">
                {fieldError}
              </p>
            ) : null}
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <Button type="submit" disabled={busy}>
            {busy ? "Yuborilmoqda…" : "Havola so'rash"}
          </Button>
          <p className="text-xs text-muted-foreground">{FORGOT_STAFF_HINT}</p>
        </form>
      </CardContent>
    </Card>
  );
}
