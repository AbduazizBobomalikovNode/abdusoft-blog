import type { Metadata } from "next";
import { TaklifAcceptClient } from "@/components/taklif-accept-client";
import { getStaffInvitePublic } from "@/lib/api";

export const metadata: Metadata = { title: "Xodim taklifi" };

const STATUS_MESSAGES: Record<string, string> = {
  expired: "Bu taklif havolasining muddati tugagan. Admindan yangi havola so'rang.",
  used: "Bu taklif havolasi allaqachon ishlatilgan.",
  revoked: "Bu taklif havolasi bekor qilingan.",
  not_found: "Taklif topilmadi — havola noto'g'ri bo'lishi mumkin.",
};

export default async function TaklifPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getStaffInvitePublic(token);
  const status = invite?.status ?? "not_found";

  if (status !== "valid") {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Taklif yaroqsiz</h1>
        <p className="text-sm text-muted-foreground">{STATUS_MESSAGES[status] ?? "Taklif topilmadi."}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-lg font-semibold tracking-tight">Xodim sifatida qo&apos;shilish</h1>
      {invite?.note ? <p className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">{invite.note}</p> : null}
      <p className="text-sm text-muted-foreground">
        Davom etish uchun GitHub hisobingiz bilan kiring. Postlaringiz admin tasdiqlagach chop etiladi.
      </p>
      <TaklifAcceptClient token={token} />
    </div>
  );
}
