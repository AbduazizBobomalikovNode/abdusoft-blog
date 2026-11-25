import type { DistributionProviderSettingsDto, DistributionSettingsResponse } from "@blog/shared";
import { LINKEDIN_TERMS_CLAUSE, PROVIDER_IDS, PROVIDER_METADATA } from "../registry.js";
import { accountView, getActiveAccount } from "./accounts.js";
import { capabilitiesDto } from "./channels.js";
import { credentialsReady, getCredentials, getCredentialsAdmin, isOAuthProvider } from "./credentials.js";
import { distNow, getProvider, redirectUrlFor } from "./env.js";

export async function buildSettingsView(): Promise<DistributionSettingsResponse> {
  const providers: DistributionProviderSettingsDto[] = [];
  for (const id of PROVIDER_IDS) {
    const meta = PROVIDER_METADATA[id];
    const p = getProvider(id);
    const row = await getActiveAccount(id);
    const oauth = isOAuthProvider(id);
    providers.push({
      id,
      name: meta.name,
      authKind: p.auth.kind,
      ownerSetup: [...meta.ownerSetup],
      scopes: [...meta.scopes],
      redirectUrl: oauth ? redirectUrlFor(id) : null,
      costsMoney: meta.costsMoney === "yes",
      costNote: meta.costNote,
      tokenLifetime: meta.tokenLifetime,
      restrictions: [...meta.restrictions],
      docs: [...meta.docs],
      credentials: oauth ? await getCredentialsAdmin(id) : null,
      credentialsReady: oauth ? credentialsReady(id, await getCredentials(id)) : true,
      account: row ? accountView(row, distNow()) : null,
      capabilities: capabilitiesDto(id),
    });
  }
  return {
    enabled: true,
    providers,
    autoPost: false,
    linkedinTermsNote: `LinkedIn API shartlari ${LINKEDIN_TERMS_CLAUSE.section}: «${LINKEDIN_TERMS_CLAUSE.quote}». Shu sabab bu tizim hech narsani AVTOMATIK yubormaydi: post faqat siz (yoki sizning yordamchingiz) aniq buyruq berganda yuboriladi.`,
  };
}
