import type { NextConfig } from "next";

/**
 * Hozircha maqola kontenti va cover rasmlar oddiy `<img>` bilan chiqariladi
 * (Tiptap HTML'idagi ixtiyoriy manbalar tufayli), lekin kelajakda `next/image`
 * ishlatilsa shu ruxsat ro'yxati kerak bo'ladi. `api.abdusoft.uz/uploads/*`
 * (R2 sozlanmagan holatdagi mahalliy saqlash) va R2 public domeni shu yerga
 * qo'shiladi — R2 domeningizni environment variable orqali emas, to'g'ridan-
 * to'g'ri shu ro'yxatga qo'lda qo'shing (Next remotePatterns build vaqtida
 * statik bo'lishi kerak).
 */
function apiHostname(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").hostname;
  } catch {
    return "localhost";
  }
}

const nextConfig: NextConfig = {
  /* config options here */
  agentRules: false,
  // Dev indikatori (pastki-chapdagi "N" belgisi) admin sidebar'ning "Chiqish"
  // tugmasi bilan 1440x900'da bir-birining ustiga chiqib qolgan edi — indikatorni
  // pastki-o'ngga ko'chiramiz (faqat development'da chiqadi, prod'ga ta'siri yo'q).
  devIndicators: {
    position: "bottom-right",
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: apiHostname(), pathname: "/uploads/**" },
      { protocol: "http", hostname: apiHostname(), pathname: "/uploads/**" },
      // R2 public bucket domeningizni shu yerga qo'shing, masalan:
      // { protocol: "https", hostname: "pub-xxxxxxxx.r2.dev" },
      // yoki custom domen ulangan bo'lsa: { protocol: "https", hostname: "cdn.abdusoft.uz" },
    ],
  },
  // Kirish va rozilik sahifalari iframe ichida ochilmasin (clickjacking: foydalanuvchini ilovaga ruxsat berishga aldash).
  // Faqat shu ikki yo'lga ta'sir qiladi.
  async headers() {
    const framing = [
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
    ];
    return [
      { source: "/login", headers: framing },
      { source: "/consent", headers: framing },
    ];
  },
  async redirects() {
    return [
      {
        source: "/p/:slug",
        destination: "/:slug",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
