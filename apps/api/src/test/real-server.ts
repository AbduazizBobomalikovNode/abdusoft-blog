import { createConnection } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";

/** Ilovani HAQIQIY Node HTTP serverda (productionda ishlatiladigan `@hono/node-server` adapteri bilan) efemer portda ishga tushiradi. */
export async function startRealServer(app: Hono): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s as Server));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** `{"jsonrpc":"2.0","id":1,"method":"ping"}` (40 bayt) + bo'shliqlar — aniq `size` baytli to'g'ri JSON-RPC so'rovi. */
export function pingBody(size: number): Buffer {
  const base = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  if (size < base.length) throw new Error("size too small");
  return Buffer.from(base + " ".repeat(size - base.length));
}

export interface RawResult {
  status: number | "timeout" | "error";
  ms: number;
  body: string;
  error?: string;
}

/**
 * Content-Length yoki chunked rejimda aniq baytlarni yuboradi (xom TCP: server tanani to'liq o'qimay 413 berib ulanishni yopsa
 * ham, javob holat qatori o'qiladi); javob holatini (yoki taym-autni) qaytaradi.
 */
export function rawPost(opts: {
  port: number;
  token?: string;
  body: Buffer;
  mode: "content-length" | "chunked";
  chunkSize?: number;
  method?: string;
  timeoutMs?: number;
  /** Bo'laklar orasidagi pauza (ms): server erta javob berib yopsa, javob RST bilan yo'qolmasin. */
  pauseMs?: number;
  /** Yuborilgan baytlar soni yoziladi (test uchun). */
  sent?: { bytes: number };
}): Promise<RawResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let raw = "";
    const sock = createConnection({ host: "127.0.0.1", port: opts.port });
    const finish = (status: RawResult["status"], error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      const i = raw.indexOf("\r\n\r\n");
      resolve({ status, ms: Date.now() - started, body: i >= 0 ? raw.slice(i + 4) : "", ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => finish("timeout"), opts.timeoutMs ?? 10_000);
    const lines = [
      `${opts.method ?? "POST"} /mcp HTTP/1.1`,
      "Host: 127.0.0.1",
      "content-type: application/json",
      "accept: application/json, text/event-stream",
      "mcp-protocol-version: 2025-06-18",
      "connection: close",
      ...(opts.token ? [`authorization: Bearer ${opts.token}`] : []),
      opts.mode === "content-length" ? `content-length: ${opts.body.length}` : "transfer-encoding: chunked",
    ];
    sock.on("data", (d) => {
      raw += d.toString();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(raw);
      // Holat qatori keldi; tana to'liq kelishi uchun ulanish yopilishini (connection: close) kutamiz.
      const end = raw.indexOf("\r\n\r\n");
      if (m && end >= 0) {
        statusSeen = Number(m[1]);
        // Javob tanasi to'liq kelgan bo'lsa (Content-Length) — ulanish RST bilan uzilishidan oldin darhol yakunlaymiz.
        const cl = /content-length: (\d+)/i.exec(raw.slice(0, end));
        if (cl && raw.length - end - 4 >= Number(cl[1])) finish(statusSeen);
      }
    });
    let statusSeen: number | undefined;
    sock.on("close", () => finish(statusSeen ?? "error", statusSeen ? undefined : "closed without response"));
    sock.on("error", () => undefined);
    sock.on("connect", () => {
      sock.write(lines.join("\r\n") + "\r\n\r\n");
      const size = opts.chunkSize ?? 64 * 1024;
      let off = 0;
      const pump = () => {
        while (off < opts.body.length && !settled) {
          const piece = opts.body.subarray(off, off + size);
          off += piece.length;
          const frame = opts.mode === "chunked" ? Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from("\r\n")]) : piece;
          if (opts.sent) opts.sent.bytes += piece.length;
          if (!sock.write(frame)) return void sock.once("drain", pump);
          if (opts.pauseMs) return void setTimeout(pump, opts.pauseMs);
        }
        if (!settled && opts.mode === "chunked") sock.write("0\r\n\r\n");
      };
      // Content-Length rejimida server tanani ko'rmay 413 bilan javob berishi mumkin: shuning uchun tanani yuborishdan oldin
      // qisqa fursat beramiz (aks holda yopilgan ulanishdagi RST javobni yutib yuboradi — bu mijoz poygasi, server xatosi emas).
      if (opts.mode === "content-length") setTimeout(() => !settled && pump(), 150);
      else pump();
    });
  });
}

/** Sarlavhalarni yuborib, tanani umuman yubormaydigan (yoki sekin tomchilatadigan) xom TCP so'rovi. */
export function rawSocket(opts: { port: number; head: string; steps?: Array<{ afterMs: number; data: Buffer | string }>; timeoutMs?: number }): Promise<{ status: number | "timeout"; ms: number; raw: string }> {
  const started = Date.now();
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const sock = createConnection({ host: "127.0.0.1", port: opts.port });
    const finish = (status: number | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ status, ms: Date.now() - started, raw });
    };
    const timer = setTimeout(() => finish("timeout"), opts.timeoutMs ?? 10_000);
    sock.on("connect", () => {
      sock.write(opts.head);
      for (const s of opts.steps ?? []) setTimeout(() => !done && sock.write(s.data), s.afterMs);
    });
    sock.on("data", (d) => {
      raw += d.toString();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(raw);
      if (m) finish(Number(m[1]));
    });
    sock.on("error", () => finish("timeout"));
  });
}
