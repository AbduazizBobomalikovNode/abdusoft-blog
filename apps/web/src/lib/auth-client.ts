import { createAuthClient } from "better-auth/react";
import { site } from "./site";

export const authClient = createAuthClient({
  baseURL: site.apiUrl,
});

export const { signIn, signOut, useSession } = authClient;
