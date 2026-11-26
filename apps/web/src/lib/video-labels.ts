import type { MotionJob } from "@blog/shared";

export const JOB_STATUS_LABEL: Record<MotionJob["status"], string> = {
  queued: "Navbatda",
  running: "Tayyorlanmoqda",
  ready: "Tayyor",
  failed: "Xato",
  cancelled: "Bekor qilingan",
};

export const JOB_KIND_LABEL: Record<MotionJob["kind"], string> = {
  preview: "Ko'rik kadrlari",
  render: "Video (MP4)",
  gif: "GIF",
};

/** Mashina kodidan o'zbekcha tushuntirish; noma'lum kod bo'lsa serverning xavfsiz xabari. */
export function jobErrorText(job: Pick<MotionJob, "errorCode" | "errorMessage">): string {
  switch (job.errorCode) {
    case "timeout":
      return "Vaqt chegarasi tugadi va ish to'xtatildi.";
    case "memory":
      return "Xotira chegarasidan oshdi va ish to'xtatildi.";
    case "browser_missing":
      return "Serverda brauzer o'rnatilmagan. Egasi scripts/setup-motion-browser.sh ni bir marta ishga tushirishi kerak.";
    case "interrupted":
      return "Server qayta ishga tushdi. Videoni qaytadan boshlang.";
    case "too_large":
      return "Natija fayli juda katta. Storyboard'ni qisqartiring.";
    case "low_resources":
      return "Serverda xotira yoki disk uzoq vaqt yetmadi, ish boshlanmadi.";
    case "invalid_storyboard":
      return "Storyboard tekshiruvdan o'tmadi.";
    default:
      return job.errorMessage ?? "Noma'lum xato.";
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const isActiveJob = (job: Pick<MotionJob, "status">): boolean => job.status === "queued" || job.status === "running";
