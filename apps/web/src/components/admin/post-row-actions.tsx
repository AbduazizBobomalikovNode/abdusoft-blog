"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, BarChart3, Eye, MoreHorizontal, Pencil, Pin, PinOff, Send, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { AdminPostListItem } from "@blog/shared";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { site } from "@/lib/site";

export function PostRowActions({ post, isAdmin = true }: { post: AdminPostListItem; isAdmin?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  function run(action: () => Promise<unknown>, successMessage: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(successMessage);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof AdminApiError ? error.message : "Xatolik yuz berdi");
      }
    });
  }

  async function handleDelete() {
    try {
      await adminApi.deletePost(post.id);
      toast.success("Post o'chirildi");
      setDeleteOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "O'chirib bo'lmadi");
    }
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1">
        {/* Desktop'da qator ustiga kursor kelganda ko'rinadigan tezkor tahrirlash
            tugmasi — asosiy amal uchun menyuni ochish shart bo'lmasin. */}
        <Button
          variant="ghost"
          size="icon-sm"
          asChild
          className="hidden opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 md:inline-flex"
        >
          <Link href={`/admin/postlar/${post.id}`} aria-label="Tahrirlash" title="Tahrirlash">
            <Pencil className="size-4" />
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              aria-label="Amallar"
              className="relative before:absolute before:-inset-2 before:content-['']"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/admin/postlar/${post.id}`}>
              <Pencil />
              Tahrirlash
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            {post.status === "published" ? (
              <a href={`${site.url}/${post.slug}`} target="_blank" rel="noopener noreferrer">
                <Eye />
                Ko&apos;rish
              </a>
            ) : (
              <Link href={`/admin/postlar/${post.id}/preview`}>
                <Eye />
                Ko&apos;rish
              </Link>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/admin/statistika/${post.id}`}>
              <BarChart3 />
              Statistika
            </Link>
          </DropdownMenuItem>
          {isAdmin ? (
            <>
              <DropdownMenuSeparator />
              {post.status === "published" ? (
                <DropdownMenuItem onSelect={() => run(() => adminApi.unpublishPost(post.id), "Qoralamaga qaytarildi")}>
                  <Undo2 />
                  Qoralamaga qaytarish
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => run(() => adminApi.publishPost(post.id), "Chop etildi")}>
                  <Send />
                  Chop etish
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() =>
                  run(
                    () => adminApi.updatePost(post.id, { pinned: !post.pinned }),
                    post.pinned ? "Muhim belgisi olib tashlandi" : "Muhim qilib belgilandi",
                  )
                }
              >
                {post.pinned ? <PinOff /> : <Pin />}
                {post.pinned ? "Muhimdan chiqarish" : "Muhim qilib belgilash"}
              </DropdownMenuItem>
              {post.status !== "archived" ? (
                <DropdownMenuItem onSelect={() => run(() => adminApi.archivePost(post.id), "Arxivlandi")}>
                  <Archive />
                  Arxivlash
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                O&apos;chirish
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Postni o&apos;chirish</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{post.title}&quot; butunlay o&apos;chiriladi. Bu amalni ortga qaytarib bo&apos;lmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              O&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
