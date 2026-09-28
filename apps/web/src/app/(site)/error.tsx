"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function SiteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-start gap-3 py-16">
      <p className="font-mono text-sm text-muted-foreground">Xatolik</p>
      <h1 className="text-2xl font-semibold tracking-tight">Nimadir noto&apos;g&apos;ri ketdi</h1>
      <p className="text-sm text-muted-foreground">
        Sahifani yuklashda kutilmagan xatolik yuz berdi. Qayta urinib ko&apos;ring.
      </p>
      <Button onClick={reset}>Qayta urinish</Button>
    </div>
  );
}
