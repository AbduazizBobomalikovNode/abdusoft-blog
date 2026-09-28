/**
 * Slugify helper aware of Uzbek latin apostrophe variants (o', g', ʻ, ’, `)
 * used in oʻ / gʻ digraphs. Converts them to plain ascii before slugifying.
 */
const APOSTROPHE_VARIANTS = /['’ʻʼ`]/g;

const CHAR_MAP: Record<string, string> = {
  "o‘": "o",
  "g‘": "g",
  "o'": "o",
  "g'": "g",
  "oʻ": "o",
  "gʻ": "g",
};

export function slugify(input: string): string {
  let value = input.trim().toLowerCase();

  for (const [from, to] of Object.entries(CHAR_MAP)) {
    value = value.split(from).join(to);
  }

  value = value.replace(APOSTROPHE_VARIANTS, "");

  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
