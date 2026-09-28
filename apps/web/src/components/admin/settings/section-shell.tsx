"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { SettingsTestResult } from "@blog/shared";
import { cn } from "@/lib/utils";

export function SectionShell({
  title,
  description,
  saving,
  onSave,
  testing,
  onTest,
  testResult,
  extraHeader,
  children,
}: {
  title: string;
  description?: string;
  saving: boolean;
  onSave: () => void;
  testing?: boolean;
  onTest?: () => void;
  testResult?: SettingsTestResult | null;
  extraHeader?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          {extraHeader}
        </div>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
      <CardFooter className="flex flex-col items-start gap-2 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={onSave} disabled={saving} size="sm">
            {saving ? "Saqlanmoqda…" : "Saqlash"}
          </Button>
          {onTest ? (
            <Button type="button" variant="outline" size="sm" onClick={onTest} disabled={testing}>
              {testing ? "Tekshirilmoqda…" : "Tekshirish"}
            </Button>
          ) : null}
        </div>
        {testResult ? (
          <div
            className={cn(
              "flex items-start gap-1.5 text-xs",
              testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
          >
            {testResult.ok ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span>{testResult.message}</span>
          </div>
        ) : null}
      </CardFooter>
    </Card>
  );
}
