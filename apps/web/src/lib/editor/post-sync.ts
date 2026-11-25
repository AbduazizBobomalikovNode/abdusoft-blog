import type { PostConflictResponse } from "@blog/shared";
import { asPostConflict } from "@/lib/admin-client";

/**
 * Tahrirlagichning o'zi yuboradigan BARCHA postga yozuvchi so'rovlari (avtosaqlash, holat o'tishlari, versiyaga qaytarish)
 * shu navbat orqali o'tadi:
 *
 *  - so'rovlar ketma-ket bajariladi (bir vaqtda ikkita so'rov bir xil tokenni ishlatib o'zini o'zi rad ettirmaydi);
 *  - har bir so'rov navbati kelganda ENG SO'NGGI tokenni (`updatedAt`) oladi, javobdan esa yangisini saqlaydi;
 *  - haqiqiy `409` (tanada `updatedAt` bor) kelsa navbat "to'qnashuv" holatiga o'tadi va keyingi so'rovlar tarmoqqa
 *    umuman chiqmaydi (cheksiz qayta urinish yo'q) — foydalanuvchi qaror qilmaguncha.
 */
export type SyncConflict = PostConflictResponse;

export class PostConflictBlockedError extends Error {
  constructor() {
    super("Post boshqa joyda o'zgargan — avval to'qnashuvni hal qiling");
    this.name = "PostConflictBlockedError";
  }
}

/** To'qnashuv sababli to'xtatilgan so'rovmi (tarmoq `409`i yoki navbat bloklagan). */
export function isConflictFailure(error: unknown): boolean {
  return error instanceof PostConflictBlockedError || asPostConflict(error) !== null;
}

export class PostSync {
  private tail: Promise<unknown> = Promise.resolve();
  private currentToken: string | null;
  private currentConflict: SyncConflict | null = null;
  private listeners = new Set<() => void>();

  constructor(initialToken: string | null) {
    this.currentToken = initialToken;
  }

  get token(): string | null {
    return this.currentToken;
  }

  get conflict(): SyncConflict | null {
    return this.currentConflict;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  /** Serverdan boshqa yo'l bilan (masalan `getPost`) olingan yangi token. */
  setToken(token: string | null) {
    this.currentToken = token;
  }

  /** "Oxirgi versiyani yuklash" — to'qnashuv hal bo'ldi, yangi token bilan davom etamiz. */
  resolve(token: string) {
    this.currentToken = token;
    if (this.currentConflict) {
      this.currentConflict = null;
      this.notify();
    }
  }

  /** Navbatdagi barcha so'rovlar tugagach hal bo'ladi (xatolar e'tiborga olinmaydi). */
  idle(): Promise<void> {
    return this.tail.then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * So'rovni navbatga qo'yadi. `op` navbati kelganda joriy token bilan chaqiriladi (token yo'q bo'lsa `undefined`).
   * Javobdagi `updatedAt` yangi token bo'ladi.
   */
  run<T extends { updatedAt?: string }>(op: (token: string | undefined) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.currentConflict) throw new PostConflictBlockedError();
      return this.exec(op, this.currentToken ?? undefined);
    });
  }

  /**
   * "Meniki bilan almashtirish" — bir marta tokensiz yozadi (server tekshirmaydi). Muvaffaqiyatda to'qnashuv
   * tozalanadi va javobdagi `updatedAt` yangi token bo'ladi. Tarmoq xatosida to'qnashuv holati saqlanadi.
   */
  runForced<T extends { updatedAt?: string }>(op: (token: undefined) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const result = await this.exec(() => op(undefined), undefined);
      if (this.currentConflict) {
        this.currentConflict = null;
        this.notify();
      }
      return result;
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async exec<T extends { updatedAt?: string }>(
    op: (token: string | undefined) => Promise<T>,
    token: string | undefined,
  ): Promise<T> {
    try {
      const result = await op(token);
      if (result && typeof result.updatedAt === "string") this.currentToken = result.updatedAt;
      return result;
    } catch (error) {
      const conflict = asPostConflict(error);
      if (conflict) {
        this.currentConflict = conflict;
        this.notify();
      }
      throw error;
    }
  }
}
