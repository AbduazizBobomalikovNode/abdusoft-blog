import type { ToolError } from "./types.js";
import { untrusted } from "./untrusted.js";
import type { ToolOutput } from "./types.js";

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const encode = (data: unknown) => JSON.stringify(data);

/** Natijani `maxChars`ga sig'diradi: avval `shrink` qadamlari, keyin ro'yxatni yarmlash. Hech qachon buzuq JSON qaytarmaydi. */
export function fitResult(output: ToolOutput, maxChars: number): { text: string; truncated: boolean } {
  let data: Record<string, unknown> = { ...output.data };
  let text = encode(data);
  if (text.length <= maxChars) return { text, truncated: false };

  const notes: string[] = [];

  for (const step of output.shrink ?? []) {
    if (!(step.key in data)) continue;
    if (step.mode === "drop") {
      const { [step.key]: _dropped, ...rest } = data;
      void _dropped;
      data = rest;
      notes.push(step.note);
    } else {
      const value = data[step.key];
      if (typeof value === "string") {
        const overflow = encode(data).length - maxChars;
        if (overflow > 0) {
          const keep = Math.max(200, value.length - overflow - 400);
          data = { ...data, [step.key]: value.slice(0, keep) };
          notes.push(step.note);
        }
      }
    }
    text = encode({ ...data, truncated: { reasons: notes } });
    if (text.length <= maxChars) return { text, truncated: true };
  }

  const listKey = output.listKey;
  const list = listKey ? data[listKey] : undefined;
  if (listKey && Array.isArray(list)) {
    let items = list as unknown[];
    const originalCount = items.length;
    while (items.length > 1) {
      items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
      const candidate = {
        ...data,
        [listKey]: items,
        truncated: {
          reasons: [...notes, `The result was too large: returned ${items.length} of ${originalCount} items on this page.`],
          returnedItems: items.length,
          hint: "Repeat the call with a smaller 'limit' (and the same or next 'page') to read the rest.",
        },
      };
      text = encode(candidate);
      if (text.length <= maxChars) return { text, truncated: true };
    }
  }

  // Oxirgi chora: hech narsa sig'maydi — qisqa, to'g'ri JSON.
  return {
    text: encode({
      error: {
        code: "result_too_large",
        message: "The result does not fit the response size limit.",
        hint: "Request less data (smaller 'limit', narrower filters).",
      },
    }),
    truncated: true,
  };
}

export function okResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(error: ToolError): McpToolResult {
  const payload = {
    ...(error.untrustedFields && error.untrustedFields.length > 0 ? untrusted(error.untrustedFields) : {}),
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.extra ?? {}),
    },
  };
  return { isError: true, content: [{ type: "text", text: encode(payload) }] };
}
