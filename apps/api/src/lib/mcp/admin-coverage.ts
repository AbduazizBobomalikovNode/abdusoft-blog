/**
 * Admin imkoniyatlari <-> konnektor vositalari xaritasi (QOIDA: har bir `/admin/*` marshrut yoki biror vositaga bog'lanadi,
 * yoki shu yerda sababi bilan istisno qilinadi). `admin-coverage.test.ts` marshrutlar jadvalini shu fayl bilan solishtiradi va
 * qoplanmagan marshrut qo'shilsa yiqiladi. Yangi admin imkoniyati qo'shgan PR shu faylga vosita yoki istisno (sabab bilan) qo'shadi.
 *
 * Kalit: "METHOD /yo'l" (Hono marshrut jadvalidagi ko'rinishda).
 */
export const ADMIN_ROUTE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "GET /admin/me": ["whoami"],
  // postlar
  "GET /admin/posts/trash": ["list_trash"],
  "POST /admin/posts/trash/:id/restore": ["restore_post_from_trash"],
  "DELETE /admin/posts/trash/:id": ["purge_post"],
  "GET /admin/posts": ["list_posts"],
  "POST /admin/posts": ["create_post_draft"],
  "GET /admin/posts/:id": ["get_post"],
  "GET /admin/posts/:id/preview": ["get_post"],
  "PATCH /admin/posts/:id": ["update_post", "set_channel_plan", "cancel_channel_plan"],
  "DELETE /admin/posts/:id": ["trash_post"],
  "POST /admin/posts/:id/submit": ["submit_post_for_review"],
  "POST /admin/posts/:id/approve": ["approve_post"],
  "POST /admin/posts/:id/request-changes": ["request_post_changes"],
  "POST /admin/posts/:id/publish": ["publish_post"],
  "POST /admin/posts/:id/unpublish": ["unpublish_post"],
  "POST /admin/posts/:id/archive": ["archive_post"],
  "POST /admin/posts/:id/schedule": ["schedule_post", "set_channel_plan"],
  "GET /admin/posts/:id/revisions": ["list_post_revisions"],
  "GET /admin/posts/:id/revisions/:rid": ["get_post_revision"],
  "POST /admin/posts/:id/revisions/:rid/restore": ["restore_post_revision"],
  // Telegram kanal
  "POST /admin/posts/:id/telegram/telegraph": ["refresh_telegraph_mirror"],
  "POST /admin/posts/:id/channel/preview": ["preview_channel_post"],
  "POST /admin/posts/:id/channel/preflight": ["check_channel_post"],
  "GET /admin/posts/:id/channel/versions": ["list_channel_versions", "get_channel_version"],
  "POST /admin/posts/:id/channel/versions": ["create_channel_version"],
  "PATCH /admin/posts/:id/channel/versions/:vid": ["update_channel_version"],
  "DELETE /admin/posts/:id/channel/versions/:vid": ["delete_channel_version"],
  "PUT /admin/posts/:id/channel/choice": ["set_channel_choice"],
  "DELETE /admin/posts/:id/channel/choice": ["clear_channel_choice"],
  "POST /admin/posts/:id/channel/send": ["send_to_channel"],
  "POST /admin/posts/:id/channel/resync-caption": ["resync_channel_caption"],
  // media va teglar
  "GET /admin/media": ["list_media"],
  "POST /admin/media": ["upload_image"],
  "PATCH /admin/media/:id": ["update_media_alt"],
  "DELETE /admin/media/:id": ["delete_media"],
  "GET /admin/tags": ["list_tags"],
  "POST /admin/tags": ["create_tag"],
  "PATCH /admin/tags/:id": ["update_tag"],
  "DELETE /admin/tags/:id": ["delete_tag"],
  // sayt
  "GET /admin/site": ["get_site_settings", "get_about_page"],
  "PUT /admin/site": ["update_site_settings", "update_about_page"],
  // izohlar va bloklar
  "GET /admin/comments": ["list_comments"],
  "PATCH /admin/comments/:id": ["moderate_comment"],
  "POST /admin/comments/bulk": ["moderate_comment"], // ommaviy amal = moderate_comment'ni qayta-qayta chaqirish (har biri chegaraga hisoblanadi)
  "POST /admin/comments/:id/reply": ["reply_to_comment"],
  "POST /admin/comments/:id/send-to-telegram": ["resend_reply_to_telegram"],
  "DELETE /admin/comments/:id": ["delete_comment"],
  "POST /admin/comments/:id/ban": ["ban_comment_author"],
  "GET /admin/bans": ["list_comment_bans"],
  "DELETE /admin/bans/:id": ["lift_comment_ban"],
  // statistika va jurnal
  "GET /admin/stats/overview": ["get_site_stats"],
  "GET /admin/stats/summary": ["get_stats_summary"],
  "GET /admin/stats/umami": ["get_umami_stats"],
  "GET /admin/stats/posts/:id": ["get_post_stats"],
  "GET /admin/audit": ["list_audit_log"],
  // integratsiyalar (faqat HOLAT) va sozlamalarning sir bo'lmagan qismi
  "GET /admin/telegram/status": ["get_integration_status"],
  "GET /admin/settings": ["get_integration_status"], // faqat sozlangan/sozlanmagan holati; qiymatlar HECH QACHON
  "PUT /admin/settings": ["update_site_settings"], // faqat sir bo'lmagan `general` (sayt nomi/tavsifi); sirli bo'limlar istisno (SETTINGS_SECRET_SECTIONS)
  // ijtimoiy tarqatish (faqat `DISTRIBUTION_ENABLED=true` bo'lganda marshrut va vosita mavjud)
  "GET /admin/distribution/channels": ["list_distribution_channels"],
  "GET /admin/distribution/posts/:postId": ["list_post_distributions"],
  "POST /admin/distribution/posts/:postId/:provider/preview": ["preview_distribution"],
  "PUT /admin/distribution/posts/:postId/:provider/draft": ["save_distribution_text"],
  "POST /admin/distribution/posts/:postId/:provider/send": ["send_distribution"],
  "POST /admin/distribution/posts/:postId/:provider/schedule": ["schedule_distribution"],
  "GET /admin/distribution/posts/:postId/:provider/versions": ["list_distribution_versions"],
  "POST /admin/distribution/posts/:postId/:provider/versions": ["create_distribution_version"],
  "DELETE /admin/distribution/posts/:postId/:provider/primary": ["set_distribution_primary"],
  "PATCH /admin/distribution/versions/:id": ["update_distribution_version"],
  "DELETE /admin/distribution/versions/:id": ["delete_distribution_version"],
  "POST /admin/distribution/versions/:id/primary": ["set_distribution_primary"],
  "GET /admin/distribution/items/:id": ["get_distribution_status"],
  "POST /admin/distribution/items/:id/cancel": ["cancel_distribution"],
  "POST /admin/distribution/items/:id/retry": ["retry_distribution"],
  "POST /admin/distribution/items/:id/remove": ["remove_distribution_from_platform"],
  // video (faqat `VIDEO_ENABLED=true` bo'lganda marshrut va vositalar mavjud; yaratish faqat konnektor orqali)
  "GET /admin/video/status": ["get_video_status"],
  "GET /admin/video/jobs": ["list_post_videos"],
  "GET /admin/video/jobs/:id": ["get_video_job"],
  "POST /admin/video/jobs/:id/cancel": ["cancel_video_job"],
  "DELETE /admin/video/jobs/:id": ["delete_video_job"],
  // xodimlar
  "GET /admin/staff": ["list_staff"],
  "POST /admin/staff/invites": ["create_staff_invite"],
  "POST /admin/staff/invites/:id/revoke": ["revoke_staff_invite"],
  "DELETE /admin/staff/:userId": ["remove_staff_member"],
};

export const ADMIN_ROUTE_EXCLUSIONS: Readonly<Record<string, string>> = {
  "GET /admin/posts/mine/summary": "Xodim (staff) o'z postlari hisoblagichlari uchun panel paneli. Konnektor egasi sifatida ishlaydi; list_posts va get_stats_summary shuni qoplaydi.",
  "POST /admin/telegram/test": "Egasining Telegram admin chatiga sinov xabari yuboradi (tashqi yon ta'sir, yagona foydasi - sozlamani qo'lda tekshirish). Panelda qoladi.",
  "POST /admin/settings/generate-secret": "Tasodifiy MAXFIY kalit hosil qilib QAYTARADI. Maxfiy qiymat hech qachon vosita natijasiga tushmasligi shart.",
  "POST /admin/settings/test/:section": "Integratsiyani saqlangan kalitlar bilan tashqi xizmatga ulab sinaydi va xizmat javobini (akkaunt/endpoint ma'lumotlari bo'lishi mumkin) qaytaradi. Panelda qoladi; holatni get_integration_status beradi.",
  "POST /admin/staff/:userId/password-reset-link": "Parolni tiklash havolasini yaratadi va QAYTARADI: maxfiy qiymat, uni yaratish hisobni egallash vositasi. Faqat panelda, egasining o'zi.",
  "GET /admin/connections": "Konnektor ilovalarini ko'rish/uzish ulanishning o'zini boshqaradi: yordamchi o'z ruxsatlarini yoki boshqa ilovalarni o'zgartira olmasligi kerak.",
  "DELETE /admin/connections": "Konnektor ilovalarini uzish ulanishning o'zini boshqaradi (yuqoridagiga qarang): faqat egasi panelda.",
  "GET /admin/distribution/settings": "Platforma ilovalarining kalit maydonlari (client id/secret holati) va ulanish sozlamalarini ko'rsatadi: sir bilan bog'liq bo'lgani uchun faqat panelda. Ulanish HOLATI `list_distribution_channels` bilan ko'rinadi.",
  "PUT /admin/distribution/settings": "Platforma ilovalarining client id/secret kalitlarini yozadi: sirlar (docs/claude-connector.md: sir qabul qiladigan hamma narsa istisno). Faqat egasi panelda.",
  "POST /admin/distribution/accounts/:provider/connect": "Ijtimoiy akkauntni ulashni boshlaydi (OAuth): akkaunt ulash egasining shaxsiy qarori va brauzerda tasdiqlanadi. Assistent ulay olmaydi.",
  "POST /admin/distribution/accounts/:provider/token": "Ijtimoiy akkauntga qo'lda kiritilgan kirish tokenini qabul qiladi: token maxfiy qiymat. Faqat egasi panelda.",
  "DELETE /admin/distribution/accounts/:provider": "Ijtimoiy akkauntni uzadi (tokenlar o'chadi): akkaunt ulanishini boshqarish egasiga tegishli, assistent o'zi yuboradigan kanalni uza olmasligi kerak.",
  "GET /admin/distribution/callback/:provider": "Platformaning OAuth callback'i (brauzer redirect, `code`/`state` bilan): assistent vositasi emas, faqat egasi brauzerda ulanishni tugatadi.",
  "POST /admin/distribution/items/:id/resolve": "`needs_checking` holatini hal qiladi (platformada post borligini egasi o'zi tekshirib, 'yuborilgan' deb belgilaydi yoki ongli qayta urinadi): egasining qarori; assistent hal qila olmaydi (`get_distribution_status` faqat holatni aytadi).",
  "GET /admin/video/settings": "GitHub runner sozlamalarini (token holati/maskasi, repozitoriy) ko'rsatadi: token maxfiy qiymat bilan bog'liq, faqat egasi panelda. Sozlanganlik holati `get_video_status` bilan ko'rinadi (qiymatsiz).",
  "PUT /admin/video/settings": "GitHub tokenini (Actions: Read and write) va repozitoriyni yozadi: token maxfiy qiymat (docs/claude-connector.md: sir qabul qiladigan hamma narsa istisno), uni yordamchi o'zgartira olmasligi kerak. Faqat egasi panelda.",
  "DELETE /admin/connections/:clientId": "Konnektor ilovasini uzish ulanishning o'zini boshqaradi (yuqoridagiga qarang): faqat egasi panelda.",
};

/**
 * `PUT /admin/settings` bo'limlari: vosita FAQAT `general`ni o'zgartiradi. Qolgan bo'limlar sirlarni (token, kalit, parol, webhook
 * sirri) yoki ularga bog'liq kritik sozlamalarni qabul qiladi va shu sababli istisno (qiymatlarni o'qish ham, yozish ham yo'q).
 */
export const SETTINGS_SECRET_SECTIONS: Readonly<Record<string, string>> = {
  telegram: "bot token, webhook sirri, kanal/chat identifikatorlari",
  telegraph: "Telegraph kirish tokeni",
  turnstile: "Turnstile maxfiy kaliti",
  r2: "R2 kirish kalitlari",
  umami: "Umami API kaliti va parol",
  github: "GitHub OAuth clientSecret",
};
