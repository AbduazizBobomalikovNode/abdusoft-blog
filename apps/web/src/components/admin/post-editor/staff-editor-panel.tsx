"use client";

import type { TagWithCount } from "@blog/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CoverImagePicker } from "./cover-image-picker";
import { TagMultiselect } from "./tag-multiselect";

/**
 * Xodim (staff) muharrir yon paneli — faqat API ruxsat bergan maydonlar
 * (`STAFF_EDITABLE_POST_FIELDS`): muqova, qisqacha tavsif, teglar. Nashr,
 * rejalashtirish, sozlamalar (izoh/reaksiya toggle'lari) va "muhim" belgisi
 * bu yerda YO'Q — ularni o'zgartirishga urinish serverda 403 qaytaradi.
 */
export function StaffEditorPanel({
  allTags,
  selectedTagSlugs,
  onTagsChange,
  excerpt,
  onExcerptChange,
  onExcerptAuto,
  coverUrl,
  onCoverChange,
  readOnly,
}: {
  allTags: TagWithCount[];
  selectedTagSlugs: string[];
  onTagsChange: (slugs: string[]) => void;
  excerpt: string;
  onExcerptChange: (value: string) => void;
  onExcerptAuto: () => void;
  coverUrl: string | null;
  onCoverChange: (url: string | null) => void;
  readOnly: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-3 py-4">
        <CardHeader className="gap-0.5 px-4">
          <CardTitle className="text-sm">Ko&apos;rinish</CardTitle>
          <p className="text-xs text-muted-foreground">Muqova, qisqacha tavsif va teglar</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex flex-col gap-2">
            <Label>Muqova rasm</Label>
            {readOnly ? (
              coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coverUrl} alt="Muqova" className="aspect-video w-full rounded-lg border border-border object-cover" />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                  Muqova yo&apos;q
                </div>
              )
            ) : (
              <CoverImagePicker coverUrl={coverUrl} onChange={onCoverChange} />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="staff-post-excerpt">Qisqacha tavsif</Label>
              {!readOnly ? (
                <button
                  type="button"
                  onClick={onExcerptAuto}
                  className="rounded text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Avtomatik
                </button>
              ) : null}
            </div>
            <Textarea
              id="staff-post-excerpt"
              value={excerpt}
              onChange={(event) => onExcerptChange(event.target.value)}
              placeholder="Ro'yxatlarda ko'rinadigan qisqa matn…"
              rows={3}
              readOnly={readOnly}
              disabled={readOnly}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Teglar</Label>
            {readOnly ? (
              <p className="text-sm text-muted-foreground">
                {allTags.filter((t) => selectedTagSlugs.includes(t.slug)).map((t) => t.name).join(", ") || "—"}
              </p>
            ) : (
              <TagMultiselect allTags={allTags} selectedSlugs={selectedTagSlugs} onChange={onTagsChange} />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
