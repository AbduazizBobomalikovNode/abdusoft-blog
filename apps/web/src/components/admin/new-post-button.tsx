"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AdminApiError, adminApi } from "@/lib/admin-client";

export function NewPostButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const created = await adminApi.createPost();
      router.push(`/admin/postlar/${created.id}`);
    } catch (error) {
      const message = error instanceof AdminApiError ? error.message : "Post yaratib bo'lmadi";
      toast.error(message);
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleClick} disabled={loading}>
      <Plus className="size-4" />
      {loading ? "Yaratilmoqda…" : "Yangi post"}
    </Button>
  );
}
