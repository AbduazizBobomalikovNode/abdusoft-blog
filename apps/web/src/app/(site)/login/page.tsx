"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/lib/auth-client";
import { hasSignedOAuthQuery, oauthContinuationUrl } from "@/lib/oauth-flow";
import { site } from "@/lib/site";
import { useSiteConfig } from "@/lib/site-config";

export default function LoginPage() {
  const router = useRouter();
  const config = useSiteConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [githubLoading, setGithubLoading] = useState(false);
  // Claude konnektori: avtorizatsiya so'rovi (imzolangan `oauth_query`) bilan kelgan bo'lsa — kirgandan keyin shu oqim davom etadi.
  const connecting = useSyncExternalStore(
    () => () => undefined,
    () => hasSignedOAuthQuery(window.location.search),
    () => false,
  );

  async function handleGithubLogin() {
    setGithubLoading(true);
    await signIn.social({ provider: "github", callbackURL: "/admin" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const { data, error: signInError } = await signIn.email({ email, password });

    if (signInError) {
      setLoading(false);
      setError(signInError.message ?? "Kirishda xatolik yuz berdi.");
      return;
    }

    // Claude konnektori oqimi: server `url` qaytaradi (avtorizatsiyani davom ettirish) — oddiy kirishda `null`.
    const continuation = oauthContinuationUrl(window.location.search, data);
    if (continuation) {
      window.location.href = continuation;
      return;
    }

    setLoading(false);
    router.push("/admin");
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-lg font-semibold tracking-tight">{site.name}</h1>
        <p className="text-sm text-muted-foreground">{connecting ? "Claude'ni blogga ulash uchun kiring" : "Admin panelga kirish"}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                aria-invalid={error ? true : undefined}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="password">Parol</Label>
                <Link
                  href="/parolni-unutdim"
                  className="rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Parolni unutdingizmi?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                aria-invalid={error ? true : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <Button type="submit" disabled={loading} className="mt-1">
              {loading ? "Kirilmoqda…" : "Kirish"}
            </Button>
          </form>

          {config.githubConfigured && !connecting ? (
            <>
              <div className="my-4 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                yoki
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={githubLoading}
                className="w-full"
                onClick={() => void handleGithubLogin()}
              >
                {githubLoading ? "Yo'naltirilmoqda…" : "GitHub bilan kirish (xodimlar uchun)"}
              </Button>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Link
        href="/"
        className="mx-auto flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Saytga qaytish
      </Link>
    </div>
  );
}
