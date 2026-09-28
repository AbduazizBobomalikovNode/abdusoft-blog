"use client";

import { useState } from "react";
import { Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { TagWithCount } from "@blog/shared";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdminApiError, adminApi } from "@/lib/admin-client";

function TagRow({
  tag,
  onUpdated,
  onDeleted,
}: {
  tag: TagWithCount;
  onUpdated: (tag: TagWithCount) => void;
  onDeleted: (id: string) => void;
}) {
  const [name, setName] = useState(tag.name);
  const [slug, setSlug] = useState(tag.slug);
  const [description, setDescription] = useState(tag.description ?? "");
  const [color, setColor] = useState(tag.color ?? "");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);

  async function save(patch: Partial<{ name: string; slug: string; description: string | null; color: string | null }>) {
    try {
      const updated = await adminApi.updateTag(tag.id, patch);
      onUpdated(updated);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Saqlab bo'lmadi");
    }
  }

  async function handleDelete(force: boolean) {
    try {
      await adminApi.deleteTag(tag.id, force);
      onDeleted(tag.id);
      toast.success("Teg o'chirildi");
      setDeleteOpen(false);
      setConfirmForce(false);
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 409 && !force) {
        setConfirmForce(true);
        return;
      }
      toast.error(error instanceof AdminApiError ? error.message : "O'chirib bo'lmadi");
    }
  }

  return (
    <TableRow>
      <TableCell>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => name !== tag.name && void save({ name })}
          className="h-8"
        />
      </TableCell>
      <TableCell>
        <Input
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          onBlur={() => slug !== tag.slug && void save({ slug })}
          className="h-8 font-mono text-xs"
        />
      </TableCell>
      <TableCell>
        <Input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => description !== (tag.description ?? "") && void save({ description: description || null })}
          placeholder="—"
          className="h-8"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={color || "#888888"}
            onChange={(event) => {
              setColor(event.target.value);
              void save({ color: event.target.value });
            }}
            className="size-6 rounded border border-border"
            aria-label="Teg rangi"
          />
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{tag.postsCount}</TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive"
          onClick={() => setDeleteOpen(true)}
          aria-label="O'chirish"
        >
          <Trash2 className="size-4" />
        </Button>
      </TableCell>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setConfirmForce(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tegni o&apos;chirish</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmForce
                ? `Bu tegda ${tag.postsCount} ta post bor. Baribir o'chirilsinmi? Teg postlardan ajratiladi.`
                : `"${tag.name}" tegi o'chiriladi.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete(confirmForce)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              O&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TableRow>
  );
}

export function TagsTable({ initialTags }: { initialTags: TagWithCount[] }) {
  const [tags, setTags] = useState(initialTags);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await adminApi.createTag({ name: newName.trim() });
      setTags((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName("");
      toast.success("Teg qo'shildi");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Qo'shib bo'lmadi");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleCreate();
          }}
          placeholder="Yangi teg nomi…"
          className="w-56"
        />
        <Button type="button" size="sm" disabled={creating || !newName.trim()} onClick={() => void handleCreate()}>
          <Plus className="size-4" />
          Qo&apos;shish
        </Button>
      </div>

      {tags.length === 0 ? (
        <EmptyState icon={TagIcon} message="Hali teg yo'q." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nomi</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Tavsif</TableHead>
                <TableHead>Rang</TableHead>
                <TableHead>Postlar</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tags.map((tag) => (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  onUpdated={(updated) =>
                    setTags((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
                  }
                  onDeleted={(id) => setTags((prev) => prev.filter((t) => t.id !== id))}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
