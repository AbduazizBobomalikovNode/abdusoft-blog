import { NextResponse, type NextRequest } from "next/server";
import { extraHeadersFor } from "@/lib/page-headers";

/**
 * Faqat quyidagi yo'llarga header qo'shadi (qolgan marshrutlar proxy'dan o'tmaydi): admin panel (`/admin/**`),
 * "Parolni unutdingizmi?" va parolni tiklash sahifalari. Mantiq `lib/page-headers.ts`da (testlangan).
 */
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(extraHeadersFor(request.nextUrl.pathname))) {
    response.headers.set(key, value);
  }
  return response;
}

// Qiymatlar build vaqtida statik bo'lishi shart (o'zgaruvchi emas) — `lib/page-headers.ts`dagi PROXY_MATCHER bilan mos (test tekshiradi).
export const config = {
  matcher: ["/admin/:path*", "/parolni-unutdim", "/parolni-tiklash"],
};
