import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { site } from "./site";

/**
 * `oauthProviderClient()` faqat Claude konnektori (OAuth) oqimida ishlaydi: sahifa manzilida imzolangan
 * `sig` parametri bo'lsa, so'rovlarga `oauth_query` qo'shadi. Oddiy kirishda hech narsa o'zgarmaydi.
 */
export const authClient = createAuthClient({
  baseURL: site.apiUrl,
  plugins: [oauthProviderClient()],
});

export const { signIn, signOut, useSession } = authClient;
