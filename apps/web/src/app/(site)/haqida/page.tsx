import { ArticleBody } from "@/components/article-body";
import { getSite } from "@/lib/api";
import { site } from "@/lib/site";

export const revalidate = 300;

export default async function AboutPage() {
  const data = await getSite();
  const html = data?.about.html?.trim();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Haqida</h1>
      {html ? (
        <ArticleBody html={html} />
      ) : (
        <div className="prose-article">
          <p>
            {site.name} — IT, sun&apos;iy intellekt (AI), AGI, LLM, agentlar va robototexnika
            mavzularida shaxsiy texnologik blog. Bu yerda men o&apos;rganganlarim, tajribalarim va
            fikrlarimni yozib boraman.
          </p>
        </div>
      )}
    </div>
  );
}
