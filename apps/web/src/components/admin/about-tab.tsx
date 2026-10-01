"use client";

import { useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { toast } from "sonner";
import type { SiteSettingsAdmin } from "@blog/shared";
import { EditorToolbar } from "@/components/admin/editor/editor-toolbar";
import { InsertPlus } from "@/components/admin/editor/insert-plus";
import { createEditorExtensions } from "@/components/admin/editor/kit";
import { LinkPopover } from "@/components/admin/editor/link-popover";
import { ShortcutsDialog } from "@/components/admin/editor/shortcuts-dialog";
import { PostEditorBubbleMenu } from "@/components/admin/post-editor/post-editor-toolbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { AdminApiError, adminApi } from "@/lib/admin-client";

export function AboutTab({ initial }: { initial: SiteSettingsAdmin["about"] }) {
  const [saving, setSaving] = useState(false);
  const editor = useEditor({
    immediatelyRender: false,
    // "Haqida" sahifasi — rasm/jadvalsiz (sxema avvalgidek: StarterKit); yozish qulayliklari post muharriri bilan umumiy.
    extensions: createEditorExtensions({ media: false, placeholder: 'Yozishni boshlang… "/" — buyruqlar' }),
    content: (initial.json ?? { type: "doc", content: [] }) as JSONContent,
    editorProps: { attributes: { class: "tiptap prose-article" } },
  });

  async function handleSave() {
    if (!editor) return;
    setSaving(true);
    try {
      await adminApi.updateSiteSettings({ about: { json: editor.getJSON() } });
      toast.success("Haqida sahifasi saqlandi");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Saqlab bo'lmadi");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <Label>Haqida sahifasi matni</Label>
        {editor ? (
          <>
            <PostEditorBubbleMenu editor={editor} />
            <LinkPopover editor={editor} />
            <InsertPlus editor={editor} />
            <ShortcutsDialog />
          </>
        ) : null}
        <div className="rounded-lg border border-border">
          {editor ? <EditorToolbar editor={editor} className="about-toolbar" /> : null}
          <div className="tiptap-editor-content min-h-40 px-3 py-2">
            <EditorContent editor={editor} />
          </div>
        </div>
        <Button onClick={() => void handleSave()} disabled={saving} className="w-fit" size="sm">
          {saving ? "Saqlanmoqda…" : "Saqlash"}
        </Button>
      </CardContent>
    </Card>
  );
}
