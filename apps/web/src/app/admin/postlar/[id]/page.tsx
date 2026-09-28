import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PostEditor } from "@/components/admin/post-editor/post-editor";
import { getAdminPost, getAdminTags, getMe } from "@/lib/api";

export default async function PostEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const headersList = await headers();
  const cookie = headersList.get("cookie");

  const [post, allTags, me] = await Promise.all([getAdminPost(id, cookie), getAdminTags(cookie), getMe(cookie)]);

  if (!post) {
    // Xodim uchun bu 403 (o'ziga tegishli bo'lmagan post) yoki 404 bo'lishi
    // mumkin — ikkalasi ham "topilmadi" sifatida ko'rsatiladi.
    notFound();
  }
  if (!me) {
    redirect("/login");
  }

  return <PostEditor post={post} allTags={allTags} me={me} />;
}
