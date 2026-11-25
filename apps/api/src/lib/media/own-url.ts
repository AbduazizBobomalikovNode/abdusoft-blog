import { config } from "../../config.js";
import { getSettings } from "../settings.js";

function normalisedPrefix(base: string, pathPrefix: string): URL | null {
  try {
    const u = new URL(`${base.replace(/\/+$/, "")}${pathPrefix}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * `url` shu blogning O'Z media manzilimi: `<API_ORIGIN>/uploads/...` yoki sozlangan R2 ochiq bazasi. Qat'iy: URL ajratiladi,
 * origin va yo'l prefiksi solishtiriladi, `..` / kodlangan nuqta segmentlari, userinfo va `\` rad etiladi.
 */
export function isOwnMediaUrlWith(url: string, prefixes: URL[]): boolean {
  if (typeof url !== "string" || url.length > 2048 || url.includes("\\")) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || (u.protocol !== "https:" && u.protocol !== "http:")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  if (decoded.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  return prefixes.some((p) => u.origin === p.origin && u.pathname.startsWith(p.pathname.endsWith("/") ? p.pathname : `${p.pathname}/`) && u.pathname.length > p.pathname.length);
}

export async function ownMediaPrefixes(): Promise<URL[]> {
  const out: URL[] = [];
  const local = normalisedPrefix(config.API_ORIGIN, "/uploads/");
  if (local) out.push(local);
  try {
    const { r2 } = await getSettings();
    if (r2.enabled && r2.publicUrl) {
      const remote = normalisedPrefix(r2.publicUrl, "/");
      if (remote) out.push(remote);
    }
  } catch {
    // sozlamalar o'qilmasa faqat mahalliy yuklamalar ruxsat etiladi
  }
  return out;
}

export async function ownMediaMatcher(): Promise<(url: string) => boolean> {
  const prefixes = await ownMediaPrefixes();
  return (url) => isOwnMediaUrlWith(url, prefixes);
}
