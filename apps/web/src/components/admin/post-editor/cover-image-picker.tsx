"use client";

import { useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { toast } from "sonner";
import type { Media } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AdminApiError, adminApi } from "@/lib/admin-client";

export function CoverImagePicker({
  coverUrl,
  onChange,
}: {
  coverUrl: string | null;
  onChange: (url: string | null) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<Media[] | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const media = await adminApi.uploadMedia(file);
      onChange(media.url);
      toast.success("Muqova yuklandi");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Yuklab bo'lmadi");
    } finally {
      setUploading(false);
    }
  }

  async function openLibrary() {
    setLibraryOpen(true);
    if (library) return;
    setLoadingLibrary(true);
    try {
      const result = await adminApi.listMedia({ limit: 24 });
      setLibrary(result.items);
    } catch {
      toast.error("Media ro'yxatini yuklab bo'lmadi");
    } finally {
      setLoadingLibrary(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {coverUrl ? (
        <div className="relative overflow-hidden rounded-lg border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element -- admin ichida ixtiyoriy domendan */}
          <img src={coverUrl} alt="Muqova" className="aspect-video w-full object-cover" />
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className="absolute top-2 right-2"
            onClick={() => onChange(null)}
            aria-label="Muqovani olib tashlash"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          Muqova yo&apos;q
        </div>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus className="size-4" />
          {uploading ? "Yuklanmoqda…" : "Yuklash"}
        </Button>
        <Popover open={libraryOpen} onOpenChange={setLibraryOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" onClick={openLibrary}>
              Media dan tanlash
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72" align="start">
            {loadingLibrary ? (
              <p className="py-4 text-center text-xs text-muted-foreground">Yuklanmoqda…</p>
            ) : library && library.length > 0 ? (
              <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto">
                {library.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onChange(item.url);
                      setLibraryOpen(false);
                    }}
                    className="aspect-square overflow-hidden rounded-md border border-border hover:border-foreground/40"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.url} alt={item.alt ?? ""} className="size-full object-cover" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-xs text-muted-foreground">
                Media kutubxonasi bo&apos;sh.
              </p>
            )}
          </PopoverContent>
        </Popover>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleUpload(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}
