import { splitXThread, X_THREAD_MAX_PARTS, type ChannelCheck, DistributionImageChoice, DistributionLinkMode, DistributionPreviewResponse } from "@blog/shared";
import { check } from "../checks.js";
import { HostClient, asRecord, str } from "../http.js";
import { GITHUB_HOSTS, contentsUrl, githubHeaders, renderReadmeList } from "../providers/github.js";
import { truncateTo } from "../text.js";
import type { DistributionProvider, ImageMeta, PreflightInput, ProviderId } from "../types.js";
import { config } from "../../../config.js";
import { accountSecretsUnreadable, getActiveAccount, toConnected, type AccountRow } from "./accounts.js";
import { capabilitiesDto, channelFor } from "./channels.js";
import { getProvider, providerDeps } from "./env.js";
import { cachedPublicImageUrl, ensurePublicImageUrl, imageSourcePreview, prepareSocialImage, publicMediaBase, type SocialImageResult } from "./images.js";
import { latestPublishedPosts, loadPostForDistribution, toDistributionPost, type LoadedPost } from "./post-source.js";
import { getActiveDistribution, getLatestSent, toItemDto, type DistributionRow } from "./rows.js";

/** Public URL kerak bo'lgan providerlar (platforma rasmni o'zi yuklab oladi). */
const URL_IMAGE_PROVIDERS: ReadonlySet<ProviderId> = new Set(["threads", "instagram"]);
/** Rasm baytlarini biz yuklaymiz. */
const BYTES_IMAGE_PROVIDERS: ReadonlySet<ProviderId> = new Set(["linkedin", "x"]);

export interface PlanOverrides {
  text?: string | null;
  imageChoice?: DistributionImageChoice;
  linkMode?: DistributionLinkMode | null;
  xThread?: boolean;
  xThreadNumbering?: boolean;
}

export interface ResolvedPlan {
  post: LoadedPost;
  provider: DistributionProvider;
  providerId: ProviderId;
  row: DistributionRow | null;
  account: AccountRow | null;
  text: string;
  defaultText: string;
  edited: boolean;
  imageChoice: DistributionImageChoice;
  linkMode: DistributionLinkMode | null;
  /** Faqat X: zanjir rejimi (boshqa kanallarda doim false). */
  xThread: boolean;
  xThreadNumbering: boolean;
  image: SocialImageResult | null;
  imageUrl: string | undefined;
  checks: ChannelCheck[];
  errorCount: number;
  warnCount: number;
}

function defaultTextFor(provider: DistributionProvider, post: LoadedPost, linkMode: DistributionLinkMode | null): string {
  const dp = toDistributionPost(post);
  const base = provider.renderDefaultText(dp);
  if (provider.id === "linkedin" && linkMode === "text" && !base.includes(post.url)) {
    const limit = provider.limits.textMax ?? 3000;
    const tail = `\n\n${post.url}`;
    return `${truncateTo(base, limit - provider.measureText(tail), (s) => provider.measureText(s))}${tail}`;
  }
  return base;
}

async function readGithubReadme(account: AccountRow): Promise<string | null> {
  const acc = toConnected(account);
  const http = new HostClient(providerDeps(), GITHUB_HOSTS, [acc.accessToken]);
  const owner = acc.meta?.owner ?? acc.externalId;
  const repo = acc.meta?.repo ?? owner;
  const res = await http.request({ method: "GET", url: contentsUrl(owner, repo, "README.md"), headers: githubHeaders(acc.accessToken), mode: "read" });
  if (res.status < 200 || res.status >= 300) return null;
  const j = asRecord(res.json);
  const content = str(j.content);
  return content && j.encoding === "base64" ? Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8") : null;
}

/**
 * Bitta post + kanal uchun to'liq reja: matn, rasm va tekshiruvlar. `forSend` — yuborish paytida: Instagram/Threads uchun
 * rasm blogning media saqlashiga YOZILADI va haqiqiy ommaviy URL ishlatiladi (oldindan ko'rishda hech narsa yozilmaydi).
 * `live` — (GitHub) README'ni o'qib markerlarni tekshiradi (bitta GET).
 */
export async function resolvePlan(postId: string, providerId: ProviderId, opts: { overrides?: PlanOverrides; forSend?: boolean; live?: boolean; row?: DistributionRow | null } = {}): Promise<ResolvedPlan | null> {
  const post = await loadPostForDistribution(postId);
  if (!post) return null;
  const provider = getProvider(providerId);
  const row = opts.row === undefined ? await getActiveDistribution(postId, providerId) : opts.row;
  const account = await getActiveAccount(providerId);
  const o = opts.overrides ?? {};
  const imageChoice = o.imageChoice ?? (row?.imageChoice as DistributionImageChoice | undefined) ?? "auto";
  const linkMode: DistributionLinkMode | null = providerId === "linkedin" ? (o.linkMode ?? (row?.linkMode as DistributionLinkMode | null) ?? "article") : null;
  const xThread = providerId === "x" && (o.xThread ?? row?.xThread ?? false);
  const xThreadNumbering = providerId === "x" && (o.xThreadNumbering ?? row?.xThreadNumbering ?? false);
  const checks: ChannelCheck[] = [];

  const isGithub = providerId === "github";
  const latest = isGithub ? await latestPublishedPosts(config.DISTRIBUTION_GITHUB_README_POSTS) : [];
  const defaultText = isGithub ? renderReadmeList(latest, config.DISTRIBUTION_GITHUB_README_POSTS) : defaultTextFor(provider, post, linkMode);
  const overrideText = o.text === undefined ? row?.text ?? null : o.text;
  const edited = !isGithub && overrideText !== null && overrideText !== defaultText;
  const text = isGithub ? defaultText : overrideText ?? defaultText;

  // --- Servis darajasidagi tekshiruvlar ---
  const channel = await channelFor(providerId);
  checks.push(
    check({
      id: "dist.account",
      group: "config",
      status: channel.ready ? "ok" : "error",
      title: "Akkaunt",
      message: channel.ready ? `Ulangan: ${channel.account?.displayName ?? ""}` : channel.notReadyReason ?? "Akkaunt tayyor emas",
    }),
  );
  if (channel.account && channel.account.tokenState === "expiring") {
    checks.push(check({ id: "dist.token", group: "config", status: "warn", title: "Token muddati", message: `Token ${channel.account.daysLeft ?? "?"} kundan keyin tugaydi — qayta ulashni rejalashtiring` }));
  }
  const published = post.status === "published" && post.deletedAt === null;
  checks.push(check({ id: "dist.published", group: "config", status: published ? "ok" : "error", title: "Post holati", message: published ? "Post chop etilgan" : "Faqat chop etilgan post tarqatiladi" }));
  const sent = await getLatestSent(postId, providerId);
  if (sent && !isGithub) {
    checks.push(check({ id: "dist.resend", group: "config", status: "warn", title: "Avval yuborilgan", message: "Bu post shu kanalga allaqachon yuborilgan — yana yuborish dublikat yaratadi", value: sent.externalUrl }));
  }

  // --- Rasm ---
  let image: SocialImageResult | null = null;
  let imageUrl: string | undefined;
  let imageMeta: ImageMeta | undefined;
  const wantsImage = provider.capabilities.image && imageChoice !== "none";
  if (wantsImage) {
    image = await prepareSocialImage(post, imageChoice);
    if (image && image.ok) {
      imageMeta = { mime: image.mime, width: image.width, height: image.height, sizeBytes: image.sizeBytes };
      if (URL_IMAGE_PROVIDERS.has(providerId)) {
        if (opts.forSend) imageUrl = await ensurePublicImageUrl(postId, image);
        else imageUrl = (await cachedPublicImageUrl(postId, image.fingerprint)) ?? `${await publicMediaBase()}/distribution/${postId}.jpg`;
      }
    } else if (image && !image.ok) {
      const required = providerId === "instagram" || (providerId === "linkedin" && linkMode === "article");
      checks.push(check({ id: "dist.image", group: "media", status: required ? "error" : "warn", title: "Ijtimoiy rasm", message: required ? `Rasm tayyorlab bo'lmadi: ${image.error}` : `Rasm tayyorlab bo'lmadi (${image.error}) — rasmsiz yuboriladi` }));
    }
  }

  // --- Provayder tekshiruvlari ---
  let currentReadme: string | undefined;
  if (isGithub && opts.live && account && !accountSecretsUnreadable(account)) {
    const readme = await readGithubReadme(account).catch(() => null);
    if (readme === null) checks.push(check({ id: "dist.readme", group: "config", status: "warn", title: "README", message: "README'ni o'qib bo'lmadi — markerlar tekshirilmadi" }));
    else currentReadme = readme;
  }
  const input: PreflightInput = {
    post: toDistributionPost(post),
    ...(isGithub ? {} : { text }),
    ...(imageMeta ? { image: imageMeta } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(linkMode ? { linkMode } : {}),
    ...(providerId === "x" ? { xThread: { enabled: xThread, numbering: xThreadNumbering } } : {}),
    ...(currentReadme !== undefined ? { currentReadme } : {}),
  };
  checks.push(...provider.preflight(input));
  if (isGithub && latest.length > 0 && !latest.some((p) => p.url === post.url)) {
    checks.push(check({ id: "dist.github_scope", group: "config", status: "warn", title: "README ro'yxati", message: "Bu post so'nggi maqolalar ro'yxatiga kirmaydi — blok baribir so'nggi postlardan qayta yoziladi" }));
  }
  const errorCount = checks.filter((c) => c.status === "error").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  return { post, provider, providerId, row, account, text, defaultText, edited, imageChoice, linkMode, xThread, xThreadNumbering, image, imageUrl, checks, errorCount, warnCount };
}

export async function buildPreview(postId: string, providerId: ProviderId, opts: { overrides?: PlanOverrides; live?: boolean } = {}): Promise<DistributionPreviewResponse | null> {
  const plan = await resolvePlan(postId, providerId, { overrides: opts.overrides, live: opts.live });
  if (!plan) return null;
  const caps = capabilitiesDto(providerId);
  const src = imageSourcePreview(plan.post, plan.imageChoice);
  const channel = await channelFor(providerId);
  const sent = await getLatestSent(postId, providerId);
  const img = plan.image;
  return {
    provider: providerId,
    postId,
    postTitle: plan.post.title,
    postUrl: plan.post.url,
    text: plan.text,
    defaultText: plan.defaultText,
    edited: plan.edited,
    length: plan.provider.measureText(plan.text),
    limit: caps.textMax,
    unit: caps.textUnit,
    image: {
      source: !caps.image || plan.imageChoice === "none" ? "none" : img && img.ok ? img.source : src.source,
      width: img && img.ok ? img.width : null,
      height: img && img.ok ? img.height : null,
      sizeBytes: img && img.ok ? img.sizeBytes : null,
      previewUrl: caps.image && plan.imageChoice !== "none" ? (img && img.ok ? img.sourceUrl : src.url) : null,
      error: img && !img.ok ? img.error : null,
    },
    imageChoice: plan.imageChoice,
    linkMode: plan.linkMode,
    xThread: plan.xThread,
    xThreadNumbering: plan.xThreadNumbering,
    threadParts: plan.xThread ? splitXThread(plan.text, { numbering: plan.xThreadNumbering }).parts : null,
    threadMaxParts: plan.xThread ? X_THREAD_MAX_PARTS : null,
    checks: plan.checks,
    canSend: plan.errorCount === 0,
    errorCount: plan.errorCount,
    warnCount: plan.warnCount,
    channel,
    distribution: plan.row ? toItemDto(plan.row) : null,
    previouslySent: sent ? toItemDto(sent) : null,
  };
}

export { BYTES_IMAGE_PROVIDERS, URL_IMAGE_PROVIDERS };
