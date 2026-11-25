import type { BundledLanguage, HighlighterGeneric } from "shiki";
import { createHighlighter } from "shiki";
import type { Highlights, Token } from "../highlight.ts";
import type { RenderProps } from "../props.ts";
import { codeLines, parseDiff, type CodeLanguage, type Storyboard } from "../schema/storyboard.ts";
import { CODE_THEMES } from "../theme/tokens.ts";

type Highlighter = HighlighterGeneric<BundledLanguage, "github-light" | "github-dark">;

/** Our canonical language names to shiki grammar ids; `null` = no highlighting. */
const SHIKI_LANG: Record<CodeLanguage, BundledLanguage | null> = {
  typescript: "typescript",
  tsx: "tsx",
  javascript: "javascript",
  jsx: "jsx",
  json: "json",
  bash: "bash",
  python: "python",
  go: "go",
  rust: "rust",
  sql: "sql",
  yaml: "yaml",
  html: "html",
  css: "css",
  markdown: "markdown",
  diff: "diff",
  dockerfile: "dockerfile",
  text: null,
};

let shared: Promise<Highlighter> | null = null;
function highlighter(): Promise<Highlighter> {
  shared ??= createHighlighter({ themes: [CODE_THEMES.light, CODE_THEMES.dark], langs: [] }) as Promise<Highlighter>;
  return shared;
}

async function tokenize(h: Highlighter, text: string, lang: BundledLanguage | null, theme: "github-light" | "github-dark"): Promise<Token[][]> {
  if (lang === null) return text.split("\n").map((l) => (l.length ? [{ content: l }] : []));
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
  const { tokens } = h.codeToTokens(text, { lang, theme });
  return tokens.map((line) =>
    line
      .filter((t) => t.content.length > 0)
      .map((t) => ({
        content: t.content,
        ...(t.color ? { color: t.color } : {}),
        ...(t.fontStyle ? { fontStyle: t.fontStyle } : {}),
      })),
  );
}

/**
 * Node side of the render: shiki tokens for every code scene and every terminal command, as data.
 * Deterministic and offline (grammars and themes ship inside the shiki package).
 */
export async function computeHighlights(sb: Storyboard): Promise<Highlights> {
  const h = await highlighter();
  const theme = CODE_THEMES[sb.theme];
  const out: Highlights = { code: {}, terminal: {} };
  for (const [i, scene] of sb.scenes.entries()) {
    if (scene.type === "code") {
      const text = codeLines(scene.code).join("\n");
      out.code[String(i)] = await tokenize(h, text, SHIKI_LANG[scene.language], theme);
    } else if (scene.type === "codeDiff") {
      // One tokenization of the whole snippet (markers stripped) so context lines colour correctly.
      const text = parseDiff(scene.diff)
        .map((l) => l.text)
        .join("\n");
      out.code[String(i)] = await tokenize(h, text, SHIKI_LANG[scene.language], theme);
    } else if (scene.type === "terminal") {
      const perEntry: Record<string, Token[]> = {};
      for (const [j, entry] of scene.lines.entries()) {
        if (entry.kind !== "command") continue;
        const lines = await tokenize(h, entry.text, "bash", theme);
        perEntry[String(j)] = lines[0] ?? [];
      }
      out.terminal[String(i)] = perEntry;
    }
  }
  return out;
}

export async function prepareRenderProps(sb: Storyboard): Promise<RenderProps> {
  return { storyboard: sb, highlights: await computeHighlights(sb) };
}
