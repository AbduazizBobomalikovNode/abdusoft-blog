/**
 * Kichik semafor: bir vaqtda ko'pi bilan `limit` ta og'ir ish (masalan 40 megapikselli rasmni qayta ishlash) bajariladi,
 * qolganlari navbatda (navbat to'lsa — darhol rad). Xotira va CPU parallel yuklamalardan to'lib ketmasin.
 */
export class Gate {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}

  /** `null` — navbat to'la (chaqiruvchi "band" deb javob beradi). */
  async run<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueue) return null;
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next(); // `active` navbatdagiga o'tadi
      else this.active--;
    }
  }
}
