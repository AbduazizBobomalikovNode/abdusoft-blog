"use client";

import { useRef, useState } from "react";
import { Check, Copy, ImageIcon, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import type { Media } from "@blog/shared";
import { EmptyState } from "@/components/admin/empty-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { cn } from "@/lib/utils";

const PAGE_LIMIT = 60;

function MediaCard({
  item,
  onDeleted,
  onAltSaved,
}: {
  item: Media;
  onDeleted: (id: string) => void;
  onAltSaved: (id: string, alt: string | null) => void;
}) {
  const [alt, setAlt] = useState(item.alt ?? "");
  const [savingAlt, setSavingAlt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleAltBlur() {
    if (alt === (item.alt ?? "")) return;
    setSavingAlt(true);
    try {
      const updated = await adminApi.updateMediaAlt(item.id, alt || null);
      onAltSaved(item.id, updated.alt);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Alt matnni saqlab bo'lmadi");
    } finally {
      setSavingAlt(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(item.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await adminApi.deleteMedia(item.id);
      onDeleted(item.id);
      toast.success("Rasm o'chirildi");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "O'chirib bo'lmadi");
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
      <div className="aspect-square overflow-hidden rounded-md bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- ixtiyoriy domendan (R2 yoki lokal) */}
        <img src={item.url} alt={item.alt ?? ""} className="size-full object-cover" />
      </div>
      <Input
        value={alt}
        onChange={(event) => setAlt(event.target.value)}
        onBlur={handleAltBlur}
        placeholder="Alt matn…"
        disabled={savingAlt}
        className="h-7 text-xs"
      />
      <div className="flex items-center justify-between gap-1">
        <Button variant="ghost" size="icon-xs" onClick={handleCopy} aria-label="URL nusxalash">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setDeleteOpen(true)}
          aria-label="O'chirish"
          className="text-destructive"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rasmni o&apos;chirish</AlertDialogTitle>
            <AlertDialogDescription>
              Bu rasm butunlay o&apos;chiriladi. Postlarda ishlatilgan bo&apos;lsa, u yerda ko&apos;rinmay qoladi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              O&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function MediaGrid({
  initialItems,
  initialHasMore,
}: {
  initialItems: Media[];
  initialHasMore: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | File[]) {
    setUploading(true);
    let successCount = 0;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const media = await adminApi.uploadMedia(file);
        setItems((prev) => [media, ...prev]);
        successCount++;
      } catch (error) {
        toast.error(error instanceof AdminApiError ? error.message : `"${file.name}" yuklanmadi`);
      }
    }
    setUploading(false);
    if (successCount > 0) toast.success(`${successCount} ta rasm yuklandi`);
  }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = page + 1;
      const result = await adminApi.listMedia({ page: next, limit: PAGE_LIMIT });
      setItems((prev) => [...prev, ...result.items]);
      setHasMore(result.hasMore);
      setPage(next);
    } catch {
      toast.error("Yuklab bo'lmadi");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (event.dataTransfer.files.length > 0) void uploadFiles(event.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground transition-colors",
          dragActive ? "border-foreground/50 bg-muted/40" : "border-border",
        )}
      >
        <Upload className="size-5" />
        <p>Rasmlarni shu yerga tashlang yoki</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? "Yuklanmoqda…" : "Fayl tanlash"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) void uploadFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState icon={ImageIcon} message="Hali rasm yuklanmagan." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              onDeleted={(id) => setItems((prev) => prev.filter((i) => i.id !== id))}
              onAltSaved={(id, alt) =>
                setItems((prev) => prev.map((i) => (i.id === id ? { ...i, alt } : i)))
              }
            />
          ))}
        </div>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Yuklanmoqda…" : "Yana yuklash"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
