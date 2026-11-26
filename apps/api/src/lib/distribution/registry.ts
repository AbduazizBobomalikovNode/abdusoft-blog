import { createGithubProvider, type GithubOptions } from "./providers/github.js";
import { createInstagramProvider, type InstagramOptions } from "./providers/instagram.js";
import { createLinkedInProvider, type LinkedInOptions } from "./providers/linkedin.js";
import { createThreadsProvider, type ThreadsOptions } from "./providers/threads.js";
import { createXProvider } from "./providers/x.js";
import type { DistributionProvider, ProviderId } from "./types.js";

/**
 * Provider reyestri: statik metadata (egasiga o'zbekcha ko'rinadigan nom, platforma tomonida nima sozlash kerak,
 * scope'lar, narx, token muddati, cheklovlar) + provider yaratuvchilar. Hech narsa import paytida ishlamaydi,
 * env o'qilmaydi — to'liq inert.
 */

export interface ProviderMetadata {
  id: ProviderId;
  /** Egasiga ko'rsatiladigan nom (o'zbekcha). */
  name: string;
  /** Platforma tomonida egasi tayyorlashi kerak narsalar (qisqa qadamlar). */
  ownerSetup: readonly string[];
  scopes: readonly string[];
  /** Pul turadimi: `yes` / `no` / `unknown`. */
  costsMoney: "yes" | "no";
  costNote: string;
  tokenLifetime: string;
  /** Platforma shartlari/cheklovlar (qisqa). */
  restrictions: readonly string[];
  /** Hujjat sahifalari (asosiy). */
  docs: readonly string[];
  /** Ixtiyoriy: kalit maydonlari yorliqlari (faqat Instagram). */
  credentialLabels?: { clientId: string; clientSecret: string; configId?: string };
}

/**
 * LinkedIn API Terms of Use (oxirgi tahrir: 2022-12-13; sahifa 2026-11-25 da o'qilgan): §3.1 bandida "You will not:" ro'yxatida:
 * "Use the Content or the APIs to automate posting on the LinkedIn Services."
 * https://www.linkedin.com/legal/l/api-terms-of-use
 * DIQQAT: bu bandning aniq talqini (egasi o'z profiliga, o'z roziligi bilan chop etishi) UNVERIFIED — yuridik tekshiruv egasida.
 * Integratsiya FAQAT egasi yoki uning yordamchisi aniq buyruq berganda post qiladi, chop etilganda AVTOMATIK emas.
 */
export const LINKEDIN_TERMS_CLAUSE = {
  section: "§3.1",
  quote: "Use the Content or the APIs to automate posting on the LinkedIn Services.",
  url: "https://www.linkedin.com/legal/l/api-terms-of-use",
  lastRevised: "2022-12-13",
} as const;

export const PROVIDER_METADATA: Readonly<Record<ProviderId, ProviderMetadata>> = {
  linkedin: {
    id: "linkedin",
    name: "LinkedIn (shaxsiy profil)",
    ownerSetup: [
      "LinkedIn Developer Portal'da ilova yarating (https://www.linkedin.com/developers/apps)",
      "Products -> 'Share on LinkedIn' va 'Sign In with LinkedIn using OpenID Connect' mahsulotlarini qo'shing",
      "Auth bo'limida redirect URL'ni ro'yxatdan o'tkazing (API manzili ostida; aniq yo'l keyingi PR'da tasdiqlanadi)",
      "Client ID va Client Secret'ni saqlab qo'ying; profilingiz bilan ruxsat bering",
    ],
    scopes: ["openid", "profile", "w_member_social"],
    costsMoney: "no",
    costNote: "Self-serve mahsulotlar uchun to'lov hujjatda ko'rsatilmagan (UNVERIFIED)",
    tokenLifetime: "60 kun; dasturiy refresh yo'q — har 60 kunda qayta ulash kerak",
    restrictions: [
      `API shartlari ${LINKEDIN_TERMS_CLAUSE.section}: "${LINKEDIN_TERMS_CLAUSE.quote}" (${LINKEDIN_TERMS_CLAUSE.url}). Integratsiya faqat egasi/yordamchisi aniq ishga tushirganda post qiladi, avtomatik emas.`,
      "Kunlik limit: a'zo uchun 150 so'rov (UTC) — Share on LinkedIn sahifasi, /rest/posts uchun UNVERIFIED",
      "Postlarni va statistikani o'qish yo'q (r_member_social cheklangan)",
      "Idempotency kaliti yo'q — qayta yuborish dublikat yaratishi mumkin",
    ],
    docs: [
      "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
      "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api",
      "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow",
    ],
  },
  x: {
    id: "x",
    name: "X (Twitter)",
    ownerSetup: [
      "developer.x.com / Developer Console'da ilova yarating va to'lov kartasini ulang (pay-per-use)",
      "OAuth 2.0 ni yoqing (PKCE, Web App), scope'lar: tweet.read tweet.write users.read media.write offline.access",
      "Callback URL'ni ro'yxatdan o'tkazing (API manzili ostida; aniq yo'l keyingi PR'da tasdiqlanadi)",
      "Client ID (va konfidensial mijoz bo'lsa Client Secret) ni saqlang",
    ],
    scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    costsMoney: "yes",
    costNote: "Pay-per-use: post $0.015, URL'li post $0.200 (narx sahifasi, sana ko'rsatilmagan — Developer Console'da tekshiring)",
    tokenLifetime: "Access token ~2 soat; refresh token bilan yangilanadi (har yangilashda yangi refresh token saqlanadi)",
    restrictions: ["280 'vazn birligi'; URL = 23; emoji = 2", "Avtomatlashtirish qoidalari (Automation Rules) — to'liq matn tekshirilmadi (UNVERIFIED)"],
    docs: [
      "https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/user-access-token",
      "https://docs.x.com/x-api/posts/creation-of-a-post",
      "https://docs.x.com/x-api/media/upload-media",
      "https://docs.x.com/x-api/getting-started/pricing",
    ],
  },
  threads: {
    id: "threads",
    name: "Threads",
    ownerSetup: [
      "developers.facebook.com'da Meta ilova yarating, 'Threads API' use case'ini qo'shing",
      "threads_basic, threads_content_publish, threads_delete ruxsatlarini qo'shing; o'zingizni Threads tester sifatida qo'shing",
      "Redirect URL'ni ro'yxatdan o'tkazing (API manzili ostida; aniq yo'l keyingi PR'da tasdiqlanadi)",
      "Threads App ID va App Secret'ni saqlang",
    ],
    scopes: ["threads_basic", "threads_content_publish", "threads_delete"],
    costsMoney: "no",
    costNote: "To'lov hujjatda ko'rsatilmagan",
    tokenLifetime: "60 kun; 24 soatdan keyin yangilash mumkin (token amal qilayotgan bo'lishi shart)",
    restrictions: ["500 birlik (emoji = UTF-8 bayt soni)", "250 post / 24 soat", "Matnda 5 tagacha havola", "Advanced Access'siz faqat tester akkauntlar"],
    docs: ["https://developers.facebook.com/docs/threads/posts", "https://developers.facebook.com/docs/threads/get-started/long-lived-tokens"],
  },
  instagram: {
    id: "instagram",
    name: "Instagram",
    ownerSetup: [
      "Instagram akkauntni Professional (Creator yoki Business) qiling; Meta ilovasi biznes portfeliga (business portfolio) tegishli bo'lishi kerak",
      "developers.facebook.com'da ilova oching va 'Manage messaging & content on Instagram' use case'ini qo'shing",
      "Use case ichida 'API setup with Unified login' bo'limini oching va konfiguratsiya (configuration) yarating: majburiy instagram_basic va instagram_manage_messages, post yuborish uchun instagram_content_publish. Konfiguratsiya Config ID beradi",
      "Konfiguratsiyaga Redirect URL'ni kiriting (pastdagi manzil AYNAN shunday) va saqlang",
      "Akkauntingizni 'Instagram Tester' qiling (App roles) va taklifni Instagram veb-saytida (Settings → Apps and websites → Tester invites) qabul qiling",
      "Ilovaning Meta App ID, Meta App Secret (Settings → Basic) va Config ID'ni pastdagi maydonlarga kiriting; ilova Development rejimida qoladi (App Review kerak emas)",
      "Rasm OMMAVIY https JPEG URL'da bo'lishi kerak",
    ],
    scopes: ["instagram_basic", "instagram_manage_messages", "instagram_content_publish"],
    costsMoney: "no",
    costNote: "To'lov hujjatda ko'rsatilmagan",
    tokenLifetime: "Tizim foydalanuvchisi tokeni: standart konfiguratsiyada muddatsiz (Meta panelida 'Expiration: Never'); muddat konfiguratsiyaga bog'liq. Yangilanmaydi — token ishlamay qolsa qayta ulang",
    restrictions: ["Faqat JPEG, ommaviy URL; nisbat 4:5 – 1.91:1", "Captionda havola bosilmaydi", "100 post / 24 soat (hujjatda ziddiyat: 50)", "API orqali o'chirib bo'lmaydi", "Development rejimida faqat app roli bor akkauntlar"],
    docs: [
      "https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started",
      "https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication",
      "https://developers.facebook.com/documentation/instagram-platform/content-publishing",
    ],
    credentialLabels: { clientId: "Meta App ID", clientSecret: "Meta App Secret", configId: "Config ID" },
  },
  github: {
    id: "github",
    name: "GitHub profil README",
    ownerSetup: [
      "Profil repo'si mavjudligini tekshiring: github.com/<login>/<login> (public, README.md bilan)",
      "README'ga ikki marker qo'shing: <!-- BLOG-POSTS:START --> va <!-- BLOG-POSTS:END -->",
      "Settings -> Developer settings -> Fine-grained personal access token yarating: faqat shu repo, Contents: Read and write",
      "Tokenni integratsiyaga yopishtiring (muddatini kalendarga yozib qo'ying)",
    ],
    scopes: ["Contents: write"],
    costsMoney: "no",
    costNote: "Bepul",
    tokenLifetime: "Siz tanlaysiz: 1–366 kun yoki cheksiz (standart 30 kun); yangilash qo'lda",
    restrictions: ["README ≤ 1 MB", "Bir vaqtda PUT/DELETE ziddiyat beradi — ketma-ket bajariladi"],
    docs: ["https://docs.github.com/en/rest/repos/contents"],
  },
};

export interface ProviderFactoryOptions {
  linkedin?: LinkedInOptions;
  threads?: ThreadsOptions;
  instagram?: InstagramOptions;
  github?: GithubOptions;
}

export const PROVIDER_IDS = ["linkedin", "x", "threads", "instagram", "github"] as const satisfies readonly ProviderId[];

export function listProviderMetadata(): ProviderMetadata[] {
  return PROVIDER_IDS.map((id) => PROVIDER_METADATA[id]);
}

export function createProvider(id: ProviderId, options: ProviderFactoryOptions = {}): DistributionProvider {
  switch (id) {
    case "linkedin":
      return createLinkedInProvider(options.linkedin);
    case "x":
      return createXProvider();
    case "threads":
      return createThreadsProvider(options.threads);
    case "instagram":
      return createInstagramProvider(options.instagram);
    case "github":
      return createGithubProvider(options.github);
  }
}
