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
      return "Renderda brauzer yo'q. Mahalliy backendda egasi scripts/setup-motion-browser.sh ni ishga tushirishi kerak; GitHub'da workflow o'zi o'rnatadi.";
    case "runner_not_configured":
      return "GitHub orqali render hali sozlanmagan (token, repozitoriy yoki runner siri). docs/video.md ga qarang.";
    case "runner_auth":
      return "GitHub tokenni rad etdi (muddati tugagan yoki ruxsati yetarli emas). Yangi token yarating (Actions: Read and write).";
    case "runner_not_found":
      return "GitHub repozitoriy yoki render-video.yml workflow'ini topa olmadi (workflow main shoxida bo'lishi kerak).";
    case "runner_rejected":
      return "GitHub workflow'ni ishga tushirishni rad etdi (workflow_dispatch yoki job_id kirishi yo'q).";
    case "runner_unavailable":
      return "GitHub vaqtincha javob bermadi. Birozdan keyin qaytadan urinib ko'ring.";
    case "runner_not_started":
      return "GitHub runner o'z vaqtida ishga tushmadi. Actions yoqilganini va 'video-render' environment sozlanganini tekshiring.";
    case "runner_timeout":
      return "GitHub runner vaqt chegarasida tugatmadi va run bekor qilindi.";
    case "runner_cancelled":
      return "GitHub run tugamasdan bekor qilindi.";
    case "engine_mismatch":
      return "Server storyboard'ni qabul qildi, lekin runner'dagi render dvigateli rad etdi (versiyalar farq qiladi).";
    case "disk_full":
      return "Serverda disk to'ldi. Egasi joy bo'shatishi kerak.";
    case "upload_failed":
      return "Runner natijani serverga yuklay olmadi.";
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
