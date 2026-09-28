import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PostEditor } from "@/components/admin/post-editor/post-editor";
import { getAdminPost, getAdminTags } from "@/lib/api";

export default async function PostEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const headersList = await headers();
  const cookie = headersList.get("cookie");

  const [post, allTags] = await Promise.all([getAdminPost(id, cookie), getAdminTags(cookie)]);

  if (!post) {
    notFound();
  }

  return <PostEditor post={post} allTags={allTags} />;
}
