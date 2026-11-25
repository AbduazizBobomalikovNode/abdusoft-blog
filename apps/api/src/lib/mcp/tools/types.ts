import type { z } from "zod";
import type { Actor, ServiceErrorKind, ServiceResult } from "../../posts/types.js";

/** Bitta MCP so'rovi uchun kontekst: kim, qaysi klient, qaysi ruxsatlar bilan. */
export interface McpToolContext {
  /** Barcha xizmat funksiyalariga uzatiladigan aktyor: `{ userId, role: "admin", via: "mcp" }`. */
  actor: Actor;
  user: { id: string; email: string; name: string | null };
  client: { id: string; name: string | null };
  /** Token VA rozilik qatorining kesishmasi — vosita ishga tushishidan oldin tekshiriladi. */
  scopes: ReadonlySet<string>;
  limits: { resultMaxChars: number };
}

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Barcha vositalar faqat shu blog bilan ishlaydi (tashqi dunyoga chiqmaydi) — `false`. */
  openWorldHint: false;
}

/**
 * Vosita natijasi. `data` — JSON-ga aylanadigan ob'ekt. Natija `MCP_RESULT_MAX_CHARS`dan oshsa `fitResult`:
 * avval `shrink` (tartib bilan: maydonni olib tashlash/qisqartirish), keyin `listKey` massivini qisqartiradi.
 */
export interface ToolOutput {
  data: Record<string, unknown>;
  listKey?: string;
  /** Tartib bilan qo'llaniladigan qisqartirish qadamlari. */
  shrink?: Array<{ key: string; mode: "drop" | "truncate"; note: string }>;
}

export interface McpToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  /** Model uchun inglizcha tavsif: nima qiladi, qachon ishlatiladi, nimani qaytaradi. */
  description: string;
  /** Talab qilingan ruxsat (`@blog/shared` `MCP_SCOPES`dagi id); `null` — har qanday ulangan klient (masalan `whoami`). */
  scope: string | null;
  inputSchema: Shape;
  annotations: McpToolAnnotations;
  /** `read` — chaqiruv jurnalga yig'ilib yoziladi; `write` — xizmat funksiyasining o'zi jurnalga yozadi. */
  kind: "read" | "write";
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: McpToolContext) => Promise<ToolOutput>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: McpToolDef<Shape>): McpToolDef<Shape> {
  return def;
}

export type ToolErrorCode =
  | "insufficient_scope"
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "unprocessable"
  | "internal_error";

/** Modelga qaytariladigan, "amal qilsa bo'ladigan" xato. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly hint?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const KIND_TO_CODE: Record<ServiceErrorKind, ToolErrorCode> = {
  bad_request: "invalid_input",
  forbidden: "forbidden",
  not_found: "not_found",
  conflict: "conflict",
  unprocessable: "unprocessable",
};

/** Xizmat natijasini ochadi; xato bo'lsa `ToolError` tashlaydi (xizmatning o'z xabari + amaliy maslahat bilan). */
export function unwrap<T>(result: ServiceResult<T>, hints: { notFound?: string } = {}): T {
  if (result.ok) return result.data;
  const { kind, message, extra } = result.error;
  const code = KIND_TO_CODE[kind];
  const hint =
    kind === "not_found"
      ? hints.notFound
      : kind === "conflict"
        ? "The item changed elsewhere. Re-read it and retry with its current updatedAt."
        : undefined;
  throw new ToolError(code, message, hint, extra);
}
