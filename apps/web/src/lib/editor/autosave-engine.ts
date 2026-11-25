import type { AdminPostDetail, UpdatePostBody } from "@blog/shared";
import { AdminApiError, asPostConflict } from "@/lib/admin-client";
import { backupDiffKeys, clearBackup, saveBackup, type DraftBackup, type StorageLike } from "./draft-backup";
import { isConflictFailure, PostConflictBlockedError, type PostSync, type SyncConflict } from "./post-sync";
import { stableStringify } from "./revision-diff";

/**
 * Avtosaqlash va konflikt mantig'i — React'dan MUSTAQIL holat mashinasi (`use-autosave.ts` faqat taymerlar va React holatini
 * shu dvigatelga ulaydi). Barcha "ma'lumot yo'qolmasin" qoidalari shu yerda va to'liq testlangan.
 *
 * Qoidalar:
 *  - `local` — muharrir hozir ushlab turgan TO'LIQ holat (barcha maydonlar); `pending` — hali serverga yetmaganlari.
 *  - Hamma yozuv bitta zanjirdan (`chain`) va `PostSync` navbatidan o'tadi; holat o'tishlari (chop etish, ...) oldin
 *    kutayotgan matnni to'liq saqlaydi (`runTransition`).
 *  - `409` da: yozuv to'xtaydi, HAMMA saqlanmagan maydonlar mahalliy zaxiraga yoziladi, banner ko'rsatiladi. Jimgina token
 *    yangilash faqat server nusxasi muharrir ushlab turgan HAMMA narsaga teng bo'lsagina.
 */
export type LocalFields = Pick<UpdatePostBody, "title" | "slug" | "excerpt" | "coverUrl" | "tagSlugs" | "settings" | "pinned" | "contentJson" | "channelPlan">;

export type EngineState = "idle" | "saving" | "saved" | "error" | "offline" | "conflict";

export type FlushOutcome =
  | { kind: "empty" }
  | { kind: "saved"; updatedAt: string }
  | { kind: "conflict" }
  | { kind: "offline" }
  | { kind: "error"; message: string; retry: boolean };

/** Holat o'tishi oldidan matnni saqlab bo'lmadi (oflayn, 5xx) — o'tish bajarilmaydi, matn zaxirada qoladi. */
export class PendingNotSavedError extends Error {
  constructor(public outcome: FlushOutcome) {
    super("Matn hali saqlanmadi — aloqa yoki server muammosi. Matn saqlab qo'yildi, qayta urinib ko'ring.");
    this.name = "PendingNotSavedError";
  }
}

export interface EngineApi {
  updatePost(id: string, body: UpdatePostBody): Promise<{ updatedAt: string }>;
  getPost(id: string): Promise<AdminPostDetail>;
}

export interface EngineOptions {
  postId: string;
  sync: PostSync;
  api: EngineApi;
  storage: StorageLike | null;
  initialUpdatedAt: string;
  initialLocal: LocalFields;
  /** Joriy foydalanuvchi — o'z `409`ini aniqlash uchun. */
  meId?: string;
  /** `false` (faqat o'qish) — zaxira yozilmaydi. */
  enabled?: boolean;
  now?: () => number;
  isOnline?: () => boolean;
  onSlugConflict?: (message: string) => void;
}

function isSlugConflict(error: unknown): boolean {
  return error instanceof AdminApiError && (error.status === 409 || error.status === 400) && /slug/i.test(error.message);
}

const sameTags = (a: string[], b: string[]) => [...a].sort().join("|") === [...b].sort().join("|");

/**
 * Server nusxasi muharrir ushlab turgan HAMMA maydonga teng-mi? (Faqat `local`dagi kalitlar solishtiriladi.)
 * `true` bo'lsagina konfliktni jimgina yopish mumkin.
 */
export function localMatchesServer(local: LocalFields, server: AdminPostDetail): boolean {
  if (local.title !== undefined && local.title !== server.title) return false;
  if (local.slug !== undefined && local.slug !== server.slug) return false;
  if (local.excerpt !== undefined && (local.excerpt ?? "") !== (server.excerpt ?? "")) return false;
  if (local.coverUrl !== undefined && (local.coverUrl ?? null) !== (server.coverUrl ?? null)) return false;
  if (local.tagSlugs !== undefined && !sameTags(local.tagSlugs, server.tags.map((t) => t.slug))) return false;
  if (local.pinned !== undefined && local.pinned !== server.pinned) return false;
  if (local.contentJson !== undefined && stableStringify(local.contentJson) !== stableStringify(server.contentJson)) return false;
  if (local.settings !== undefined) {
    const serverSettings = server.settings as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(local.settings)) {
      if (stableStringify(value) !== stableStringify(serverSettings[key])) return false;
    }
  }
  if (local.channelPlan !== undefined && stableStringify(local.channelPlan) !== stableStringify(server.channelPlan)) return false;
  return true;
}

export class AutosaveEngine {
  state: EngineState = "idle";
  error: string | null = null;
  lastSavedAt: string | null;
  /** Foydalanuvchiga ko'rsatiladigan to'qnashuv (banner). */
  conflict: SyncConflict | null = null;
  /** Har bir `queueSave`da oshadi — "so'rov ketayotganda yana yozildimi" ni aniqlash uchun. */
  editCount = 0;

  private local: LocalFields;
  private pending: UpdatePostBody = {};
  private inflight: UpdatePostBody = {};
  private baseUpdatedAt: string;
  private chain: Promise<unknown> = Promise.resolve();
  private flushing = false;
  private reconciling = false;
  private listeners = new Set<() => void>();
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly isOnline: () => boolean;

  constructor(private opts: EngineOptions) {
    this.local = { ...opts.initialLocal };
    this.baseUpdatedAt = opts.initialUpdatedAt;
    this.lastSavedAt = opts.initialUpdatedAt;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? (() => Date.now());
    this.isOnline = opts.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  }

  /**
   * `PostSync`ga ulanadi: boshqa so'rov (chop etish, arxiv, ...) `409` olsa ham yozuv to'xtaydi va matn zaxiraga yoziladi.
   * Qaytgan funksiya uzadi. (React Strict Mode'da effekt ikki marta ishlaydi — shuning uchun ulash/uzish juft va qayta ishlatiladigan.)
   */
  attach(): () => void {
    const { sync } = this.opts;
    return sync.subscribe(() => {
      if (this.reconciling || this.flushing) return;
      const current = sync.conflict;
      this.conflict = current;
      if (current) {
        this.writeBackup();
        this.state = "conflict";
      } else if (this.state === "conflict") {
        this.state = "idle";
      }
      this.notify();
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  get hasPending(): boolean {
    return Object.keys(this.pending).length > 0;
  }

  /** Serverga yetmagan narsa bor (kutayotgan yoki yo'ldagi). */
  get dirty(): boolean {
    return this.hasPending || Object.keys(this.inflight).length > 0;
  }

  get pendingKeys(): string[] {
    return Object.keys(this.pending);
  }

  get localState(): LocalFields {
    return { ...this.local };
  }

  // ------------------------------------------------------------------ yozish

  queueSave(patch: Partial<UpdatePostBody>) {
    const { expectedUpdatedAt: _ignored, ...fields } = patch;
    void _ignored;
    this.pending = { ...this.pending, ...fields };
    this.local = { ...this.local, ...(fields as LocalFields) };
    this.editCount += 1;
    if (this.state === "saved" || this.state === "error") this.state = "idle";
    this.notify();
  }

  /** Kutayotganlarni yuboradi (navbatdagi zanjirda). */
  flush(): Promise<FlushOutcome> {
    return this.enqueue(() => this.flushOnce());
  }

  /**
   * Holat o'tishi (chop etish, arxiv, savatga, tiklash, ...): AVVAL yo'ldagi saqlash tugaydi va kutayotgan matn BUTUNLAY
   * yuboriladi (yozish davomida kelgan yangi harflar ham), KEYIN o'tish bajariladi. Matn saqlanmasa — o'tish
   * bajarilmaydi (`PendingNotSavedError`), matn kutayotgan va zaxirada qoladi.
   */
  runTransition<T extends { updatedAt?: string }>(op: (token: string | undefined) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      for (let round = 0; round < 5; round += 1) {
        const outcome = await this.flushOnce();
        if (outcome.kind === "conflict") break; // sync.run quyida PostConflictBlockedError beradi
        if (outcome.kind === "offline" || outcome.kind === "error") throw new PendingNotSavedError(outcome);
        if (!this.hasPending) break;
      }
      return this.opts.sync.run(op);
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job, job);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async flushOnce(): Promise<FlushOutcome> {
    if (!this.hasPending) return { kind: "empty" };
    if (this.opts.sync.conflict) return { kind: "conflict" };
    const payload = this.pending;
    this.pending = {};
    this.inflight = payload;
    this.flushing = true;
    this.state = "saving";
    this.notify();
    try {
      const result = await this.opts.sync.run((token) =>
        this.opts.api.updatePost(this.opts.postId, token ? { ...payload, expectedUpdatedAt: token } : payload),
      );
      this.inflight = {};
      this.baseUpdatedAt = result.updatedAt;
      this.lastSavedAt = result.updatedAt;
      this.state = "saved";
      this.error = null;
      if (!this.hasPending) clearBackup(this.opts.storage, this.opts.postId);
      else this.writeBackup();
      return { kind: "saved", updatedAt: result.updatedAt };
    } catch (error) {
      // Saqlanmaganlar qaytariladi — yangiroqlari ustun.
      this.pending = { ...payload, ...this.pending };
      this.inflight = {};
      this.writeBackup();
      if (isConflictFailure(error)) return await this.handleConflict(error);
      if (isSlugConflict(error) && this.pending.slug !== undefined) {
        // Band slug butun so'rovni rad etardi — matnni yo'qotmaslik uchun slug'siz qayta saqlaymiz.
        const { slug: _dropped, ...rest } = this.pending;
        void _dropped;
        this.pending = rest;
        this.opts.onSlugConflict?.(error instanceof Error ? error.message : "Slug band");
        this.flushing = false;
        return await this.flushOnce();
      }
      if ((error instanceof AdminApiError && error.status === 0) || !this.isOnline()) {
        this.state = "offline";
        this.error = null;
        return { kind: "offline" };
      }
      const message = error instanceof AdminApiError ? error.message : "Saqlashda xatolik";
      this.state = "error";
      this.error = message;
      return { kind: "error", message, retry: error instanceof AdminApiError && error.status >= 500 };
    } finally {
      this.flushing = false;
      this.notify();
    }
  }

  /**
   * `409`: server nusxasi muharrir ushlab turgan HAMMA narsaga teng bo'lsagina (javobi yo'qolgan o'z so'rovimiz yoki
   * aynan bir xil holatni yozgan ikkinchi tab) jimgina tokenni yangilaymiz. Aks holda — banner.
   */
  private async handleConflict(error: unknown): Promise<FlushOutcome> {
    const info = asPostConflict(error) ?? this.opts.sync.conflict;
    const { meId } = this.opts;
    if (info && meId && info.updatedBy?.id === meId && info.via === "web") {
      this.reconciling = true;
      try {
        const fresh = await this.opts.api.getPost(this.opts.postId);
        if (localMatchesServer(this.local, fresh)) {
          this.opts.sync.resolve(fresh.updatedAt);
          this.baseUpdatedAt = fresh.updatedAt;
          this.lastSavedAt = fresh.updatedAt;
          this.pending = {};
          clearBackup(this.opts.storage, this.opts.postId);
          this.state = "saved";
          this.error = null;
          this.conflict = null;
          return { kind: "saved", updatedAt: fresh.updatedAt };
        }
      } catch {
        // Tekshirib bo'lmadi — ehtiyotkorlik bilan to'qnashuv sifatida ko'rsatamiz.
      } finally {
        this.reconciling = false;
      }
    }
    this.state = "conflict";
    this.error = null;
    this.conflict = this.opts.sync.conflict ?? info;
    this.writeBackup();
    return { kind: "conflict" };
  }

  // ------------------------------------------------------------------ zaxira

  /** Hozirgi saqlanmagan holat (xotirada ham qaytariladi — `localStorage` ishlamasa ham yo'qolmaydi). */
  buildBackup(): DraftBackup {
    const unsaved = { ...this.inflight, ...this.pending };
    const dirty = Object.keys(unsaved);
    const extra: Record<string, unknown> = {};
    for (const key of dirty) {
      if (key !== "title" && key !== "contentJson") extra[key] = (unsaved as Record<string, unknown>)[key];
    }
    return {
      v: 1,
      postId: this.opts.postId,
      baseUpdatedAt: this.baseUpdatedAt,
      savedAt: this.now(),
      title: this.local.title ?? "",
      contentJson: this.local.contentJson,
      dirty,
      extra,
    };
  }

  writeBackup(): DraftBackup | null {
    if (!this.enabled) return null;
    const backup = this.buildBackup();
    saveBackup(this.opts.storage, backup);
    return backup;
  }

  discardPending() {
    this.pending = {};
    this.inflight = {};
  }

  // ------------------------------------------------------------------ konflikt amallari

  /**
   * "Oxirgi versiyani yuklash": HAMMA saqlanmagan maydonlar zaxiraga yoziladi, serverdagi nusxa olinadi. Qaytgan `offer` —
   * "Tiklash" taklifi uchun zaxira (serverdan farq qiladigan maydonlari bilan), yoki `null` (farq yo'q).
   */
  async loadLatest(): Promise<{ fresh: AdminPostDetail; offer: DraftBackup | null; fields: string[] }> {
    const backup = this.buildBackup();
    if (this.enabled) saveBackup(this.opts.storage, backup);
    const fresh = await this.opts.api.getPost(this.opts.postId);
    const fields = backup.dirty && backup.dirty.length > 0 ? backupDiffKeys(backup, fresh) : [];
    this.discardPending();
    this.opts.sync.resolve(fresh.updatedAt);
    if (fields.length === 0) clearBackup(this.opts.storage, this.opts.postId);
    return { fresh, offer: fields.length > 0 ? backup : null, fields };
  }

  /** `localState`ning to'liq yuborilishi: muharrirning har bir maydoni (bo'sh slug tashqari). */
  fullPayload(): UpdatePostBody {
    const full: UpdatePostBody = { ...this.local };
    if (!full.slug || full.slug.trim().length === 0) delete full.slug;
    return full;
  }

  /**
   * "Meniki bilan almashtirish": muharrirning TO'LIQ holati bir marta tokensiz yoziladi (`overwrite: true` — server
   * boshqa yozuvchining versiyasini Tarixga saqlaydi). Muvaffaqiyatsiz bo'lsa to'qnashuv va kutayotganlar saqlanadi.
   */
  overwrite(): Promise<boolean> {
    return this.enqueue(async () => {
      const previous = this.pending;
      const payload: UpdatePostBody = { ...this.fullPayload(), overwrite: true };
      this.pending = {};
      this.inflight = this.fullPayload();
      this.flushing = true;
      this.state = "saving";
      this.notify();
      try {
        const result = await this.opts.sync.runForced(() => this.opts.api.updatePost(this.opts.postId, payload));
        this.inflight = {};
        this.baseUpdatedAt = result.updatedAt;
        this.lastSavedAt = result.updatedAt;
        this.state = "saved";
        this.error = null;
        this.conflict = null;
        clearBackup(this.opts.storage, this.opts.postId);
        return true;
      } catch (error) {
        this.pending = { ...previous, ...this.pending };
        this.inflight = {};
        this.writeBackup();
        this.state = "conflict";
        this.error = error instanceof AdminApiError ? error.message : "Saqlab bo'lmadi";
        return false;
      } finally {
        this.flushing = false;
        this.notify();
      }
    });
  }

  /**
   * Tahrirlagich serverdan olingan yangi nusxa bilan almashtirilgandan keyin (versiyaga qaytarish): so'rov ketayotganda
   * (`mark` = shu paytgacha bo'lgan `editCount`) yana yozilgan bo'lsa — u yo'qolmasin: zaxira qaytariladi (taklif sifatida).
   * Yozilmagan bo'lsa — kutayotganlar tashlanadi va zaxira tozalanadi.
   */
  takeOver(mark: number): DraftBackup | null {
    if (this.editCount !== mark && this.hasPending) {
      const backup = this.buildBackup();
      if (this.enabled) saveBackup(this.opts.storage, backup);
      this.discardPending();
      return backup;
    }
    this.discardPending();
    clearBackup(this.opts.storage, this.opts.postId);
    return null;
  }

  /** Server nusxasi bilan tenglashtirish (sync tokeni va ko'rinadigan holat). */
  adoptServer(fresh: AdminPostDetail) {
    this.opts.sync.resolve(fresh.updatedAt);
    this.baseUpdatedAt = fresh.updatedAt;
    this.lastSavedAt = fresh.updatedAt;
    this.conflict = null;
    this.state = "idle";
    this.notify();
  }
}

export { PostConflictBlockedError };
