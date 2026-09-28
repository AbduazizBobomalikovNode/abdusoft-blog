"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-start gap-3 py-16">
      <p className="font-mono text-sm text-muted-foreground">Xatolik</p>
      <h1 className="text-2xl font-semibold tracking-tight">Admin panelda xatolik yuz berdi</h1>
      <p className="text-sm text-muted-foreground">
        Sahifani yuklab bo&apos;lmadi. Internet aloqasini tekshiring va qayta urinib ko&apos;ring — muammo davom
        etsa, API serverning ishlayotganini tekshiring.
      </p>
      <Button onClick={reset}>Qayta urinish</Button>
    </div>
  );
}
