"use client";

import type { ChannelVersion } from "@blog/shared";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/format";
import { cn } from "cn";
import { ChannelChecklist } from "./channel-checklist";
import { MODE_LABELS, MODE_OPTIONS, VARIANT_LABELS, VARIANTS_BY_MODE } from "./channel-preview";
import { choiceFromResolved, sameChoice, toSelection, type ChannelSendController } from "./channel-send-controller";
import { ChannelVersionEditor } from "./channel-version-editor";

/**
 * `ChannelSendDialog`ning qadam tanalari ALOHIDA komponentlar sifatida: 3 qadamli oynada ham, "Tarqatish" dialogidagi
 * Telegram panelida ham (bir sahifada ketma-ket) bir xil ishlatiladi. Holat va amallar `useChannelSend` kontrolleridan keladi.
 */

/** "Allaqachon yuborilgan" qutisi (oldindan ko'rish javobidan). */
export function AlreadySentNote({ c }: { c: ChannelSendController }) {
  const { preview } = c;
  if (!preview?.alreadySent) return null;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 p-3 text-xs">
      <p>
        Allaqachon yuborilgan —{" "}
        <span className="font-medium">
          {MODE_LABELS[preview.alreadySent.mode]} ·{" "}
          {preview.alreadySent.variant
            ? VARIANT_LABELS[preview.alreadySent.variant]
            : (preview.alreadySent.versionName ?? "maxsus versiya")}
        </span>
        , {formatDateTime(preview.alreadySent.at)}
      </p>
      {preview.alreadySent.messageUrl ? (
        <a
          href={preview.alreadySent.messageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 w-fit items-center text-primary underline underline-offset-2 md:min-h-0"
        >
          Kanalda ochish
        </a>
      ) : null}
    </div>
  );
}

function ModeSwitch({ c }: { c: ChannelSendController }) {
  const { canUseMedia, autoChoice, markedChoice, handleModeChange } = c;
  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
      {MODE_OPTIONS.map((item) => {
        const disabled = item.value === "media" && canUseMedia === false;
        const button = (
          <button
            key={item.value}
            type="button"
            disabled={disabled}
            onClick={() => handleModeChange(item.value)}
            className={cn(
              "w-full rounded-md px-2 py-1.5 text-xs font-medium transition-colors max-sm:min-h-11",
              disabled
                ? "cursor-not-allowed text-muted-foreground/50"
                : autoChoice?.mode === item.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
            )}
          >
            {markedChoice?.choice.kind === "auto" && markedChoice.choice.mode === item.value ? "★ " : ""}
            {item.label}
          </button>
        );
        if (!disabled) return button;
        return (
          <Tooltip key={item.value}>
            <TooltipTrigger asChild>
              <span>{button}</span>
            </TooltipTrigger>
            <TooltipContent>Postda kover yoki band ichida rasm yo&apos;q</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function MarkedStrip({ c }: { c: ChannelSendController }) {
  const { markedChoice, dialogMode, readOnly, marking, applyMark, clearMark } = c;
  if (!markedChoice) return null;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="channel-marked-strip">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium break-all">⭐ Belgilangan: {markedChoice.label}</span>
        {markedChoice.suggestedByStaff && dialogMode !== "suggest" ? (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            Xodim taklifi{markedChoice.setBy?.name ? ` · ${markedChoice.setBy.name}` : ""}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        <span className={cn(markedChoice.visibleLength > markedChoice.limit && "font-semibold text-destructive")}>
          {markedChoice.visibleLength} / {markedChoice.limit}
        </span>{" "}
        · {markedChoice.passes ? "✓ Telegram cheklovlaridan o'tadi" : "✗ Telegram cheklovlariga mos emas"}
      </p>
      {!readOnly ? (
        <div className="flex flex-wrap gap-1">
          {markedChoice.suggestedByStaff && dialogMode !== "suggest" ? (
            <Button type="button" size="sm" className="max-sm:h-11" disabled={marking} onClick={() => void applyMark(choiceFromResolved(markedChoice.choice))}>
              Tasdiqlash
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" className="max-sm:h-11" disabled={marking} onClick={() => void clearMark()}>
            Belgini olib tashlash
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 1-qadam: versiya tanlash ("Avtomatik" + "Mening versiyalarim"). `onEdit` berilsa har bir versiyada "Tahrirlash" tugmasi chiqadi
 * (3 qadamli oynada 2-qadamga o'tadi); panelda tahrirlagich tanlangan versiya ostida o'zi ochiladi, shuning uchun berilmaydi.
 */
export function ChannelVersionStep({ c, onEdit }: { c: ChannelSendController; onEdit?: (version: ChannelVersion) => void }) {
  const {
    readOnly, marking, autoChoice, currentIsMarked, markedChoice, choice, versions, sortedVersions, preview,
    selectAuto, selectVersion, applyMark, clearMark, handleDuplicate, setDeleteTarget, handleFork,
  } = c;
  return (
    <div className="flex flex-col gap-4">
      <MarkedStrip c={c} />
      <section className={cn("flex flex-col gap-2 rounded-lg border p-3", autoChoice ? "border-primary" : "border-border")}>
        <h3 className="text-sm font-semibold">Avtomatik</h3>
        <ModeSwitch c={c} />
        <div
          className={cn(
            "grid gap-1 rounded-lg bg-muted p-1",
            autoChoice && VARIANTS_BY_MODE[autoChoice.mode].length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4",
          )}
        >
          {VARIANTS_BY_MODE[autoChoice?.mode ?? "media"].map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => selectAuto(autoChoice?.mode ?? "media", item.value)}
              className={cn(
                "rounded-md px-2 py-1.5 text-xs font-medium transition-colors max-sm:min-h-11",
                autoChoice?.variant === item.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {markedChoice?.choice.kind === "auto" &&
              markedChoice.choice.mode === (autoChoice?.mode ?? "media") &&
              markedChoice.choice.variant === item.value
                ? "★ "
                : ""}
              {item.label}
            </button>
          ))}
        </div>
        {autoChoice && !readOnly ? (
          <Button
            type="button"
            size="sm"
            variant={currentIsMarked ? "secondary" : "outline"}
            className="w-fit max-sm:h-11"
            disabled={marking}
            onClick={() => void (currentIsMarked ? clearMark() : applyMark(autoChoice))}
          >
            {currentIsMarked ? "★ Asosiy" : "⭐ Asosiy"}
          </Button>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Mening versiyalarim</h3>
        {versions && versions.versions.length === 0 ? (
          <p className="text-xs text-muted-foreground">Hali versiya yo&apos;q. Pastdagi tugma bilan yarating.</p>
        ) : null}
        {sortedVersions.map((v) => {
          const selected = choice.kind === "version" && choice.id === v.id;
          const isMarked = sameChoice(markedChoice?.choice, { kind: "version", id: v.id });
          return (
            <div key={v.id} className={cn("flex flex-col gap-2 rounded-lg border p-3", selected ? "border-primary" : "border-border")}>
              <div className="flex flex-wrap items-center justify-between gap-x-2">
                <span className="text-sm font-medium break-all">
                  {isMarked ? <span className="mr-1 text-amber-600 dark:text-amber-400">★</span> : null}
                  {v.name}
                </span>
                <span className="text-xs text-muted-foreground">{MODE_LABELS[v.mode]}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className={cn(v.overLimit && "font-semibold text-destructive")}>
                  {v.visibleLength} / {v.limit}
                </span>
                <span>{v.mode === "media" ? `${v.imageUrls.length} ta rasm` : "rasmsiz"}</span>
                <span>{formatDateTime(v.updatedAt)}</span>
                {v.postChanged ? <span className="text-amber-600 dark:text-amber-400">post o&apos;zgargan</span> : null}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button type="button" size="sm" variant={selected ? "secondary" : "outline"} className="max-sm:h-11" onClick={() => selectVersion(v)}>
                  {selected ? "Tanlangan" : "Tanlash"}
                </Button>
                {!readOnly ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={isMarked ? "secondary" : "outline"}
                    className="max-sm:h-11"
                    disabled={marking}
                    onClick={() => void (isMarked ? clearMark() : applyMark({ kind: "version", id: v.id }))}
                  >
                    {isMarked ? "★ Asosiy" : "⭐ Asosiy"}
                  </Button>
                ) : null}
                {!readOnly ? (
                  <>
                    {onEdit ? (
                      <Button type="button" size="sm" variant="outline" className="max-sm:h-11" onClick={() => onEdit(v)}>
                        Tahrirlash
                      </Button>
                    ) : null}
                    <Button type="button" size="sm" variant="outline" className="max-sm:h-11" onClick={() => void handleDuplicate(v)}>
                      Nusxalash
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="text-destructive max-sm:h-11" onClick={() => setDeleteTarget(v)}>
                      O&apos;chirish
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
        {!readOnly ? (
          <Button type="button" variant="outline" size="sm" className="max-sm:h-11" disabled={!preview} onClick={() => void handleFork()}>
            Shu ko&apos;rinishdan yangi versiya
          </Button>
        ) : null}
      </section>

      {preview ? (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>
            {preview.visibleLength} / {preview.limit} belgi
            {preview.truncated ? " (qisqartirilgan)" : ""}
          </span>
          {preview.mode === "media" ? (
            <span>{preview.media.length} ta rasm</span>
          ) : (
            <span>Oddiy matn xabari — rasmsiz, havola oldindan ko&apos;rinishi o&apos;chirilgan</span>
          )}
        </div>
      ) : null}

      <AlreadySentNote c={c} />
    </div>
  );
}

/** 2-qadam: tanlangan maxsus versiyani tahrirlash (saqlangach oldindan ko'rish qayta yuklanadi). */
export function ChannelEditStep({ c }: { c: ChannelSendController }) {
  const { selectedVersion, versions, postId, registerFlush, setVersions, choiceRef, loadPreview } = c;
  if (!selectedVersion || !versions) {
    return <p className="text-sm text-muted-foreground">Tahrirlash uchun avval maxsus versiyani tanlang.</p>;
  }
  return (
    <ChannelVersionEditor
      key={selectedVersion.id}
      postId={postId}
      version={selectedVersion}
      postImages={versions.postImages}
      registerFlush={registerFlush}
      onSaved={(saved) => {
        setVersions((prev) =>
          prev ? { ...prev, versions: prev.versions.map((v) => (v.id === saved.id ? saved : v)) } : prev,
        );
        // Foydalanuvchi shu orada boshqa tanlovga o'tgan bo'lsa, uning ko'rinishini bosib ketmaymiz.
        if (choiceRef.current.kind === "version" && choiceRef.current.id === saved.id) void loadPreview({ versionId: saved.id });
      }}
    />
  );
}

/** 3-qadam: Telegram cheklovlari (preflight) ro'yxati, qayta tekshirish va ogohlantirishni tasdiqlash. */
export function ChannelCheckStep({ c, showSentNote = true }: { c: ChannelSendController; showSentNote?: boolean }) {
  const { dialogMode, sending_, checking, preflight, ack, setAck, runPreflight, choice, needsAck } = c;
  return (
    <div className="flex flex-col gap-3">
      {showSentNote ? <AlreadySentNote c={c} /> : null}
      {dialogMode === "prepare" ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Post chop etilgach yuboriladi (qo&apos;lda yoki rejaga ko&apos;ra).
        </p>
      ) : null}
      {dialogMode === "suggest" ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Bu taklif — kanalga yuborishni admin hal qiladi.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Telegram cheklovlari</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-sm:h-11"
          disabled={checking}
          onClick={() => void runPreflight(toSelection(choice))}
        >
          {checking ? "Tekshirilmoqda…" : "Qayta tekshirish"}
        </Button>
      </div>
      {checking && !preflight ? <p className="text-sm text-muted-foreground">Tekshirilmoqda…</p> : null}
      {preflight ? (
        <>
          <ChannelChecklist preflight={preflight} />
          {!preflight.canSend ? (
            <p className="text-xs text-destructive">
              {sending_ ? "Xatolar tuzatilmaguncha kanalga yuborib bo'lmaydi." : "Xatolarni tuzatmaguncha bu versiya kanalga yuborilmaydi."}
            </p>
          ) : null}
          {sending_ && preflight.canSend && needsAck ? (
            <label className="flex items-center gap-2 text-sm max-sm:min-h-11">
              <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
              Ogohlantirishlarni ko&apos;rdim
            </label>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** "Qayta yuborilsinmi?" va "Versiya o'chirilsinmi?" tasdiqlari (ikkala joyda bir xil). */
export function ChannelSendAlerts({ c }: { c: ChannelSendController }) {
  const { confirmReplaceOpen, setConfirmReplaceOpen, sending, handleSend, deleteTarget, setDeleteTarget, handleDelete } = c;
  return (
    <>
      <AlertDialog open={confirmReplaceOpen} onOpenChange={setConfirmReplaceOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Qayta yuborilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              Eski kanal posti va uning butun izoh ipi (muhokama guruhidagi barcha izohlar bog&apos;lanishi) o&apos;chirib
              tashlanadi va o&apos;rniga yangisi yuboriladi. Bu amalni ortga qaytarib bo&apos;lmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              disabled={sending}
              onClick={() => void handleSend(true)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Ha, qayta yuborish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Versiya o&apos;chirilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleteTarget?.name}&quot; versiyasi o&apos;chiriladi. Kanalga yuborilgan xabarga tegilmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Ha, o&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
