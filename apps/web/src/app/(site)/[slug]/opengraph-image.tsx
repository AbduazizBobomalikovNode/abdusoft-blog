import { ImageResponse } from "next/og";
import { getPost } from "@/lib/api";
import { site } from "@/lib/site";

// Brend belgisi (public/brand/abdusoft-mark.svg bilan bir xil) — satori uchun data URI.
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0B1220"/>' +
  '<rect x=".5" y=".5" width="63" height="63" rx="13.5" fill="none" stroke="#fff" stroke-opacity=".16"/>' +
  '<g fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M13.5 46 L23.5 18 L33.5 46" stroke="#fff"/><path d="M44.5 46 H51.5" stroke="#3B9EFF"/></g></svg>';
const MARK_SRC = `data:image/svg+xml;base64,${Buffer.from(MARK_SVG).toString("base64")}`;

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);
  const title = post?.title ?? site.name;
  const tags = post?.tags.map((tag) => tag.name).slice(0, 4) ?? [];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          backgroundColor: "#0b0b0d",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <img src={MARK_SRC} width={56} height={56} alt="" />
          <div style={{ display: "flex", fontSize: 28, letterSpacing: 2, opacity: 0.7 }}>
            {site.name.toUpperCase()}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 60,
            fontWeight: 600,
            lineHeight: 1.2,
            maxWidth: 980,
          }}
        >
          {title}
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {tags.map((tag) => (
            <div
              key={tag}
              style={{
                display: "flex",
                fontSize: 24,
                padding: "6px 18px",
                borderRadius: 999,
                border: "1px solid rgba(250,250,250,0.3)",
                opacity: 0.85,
              }}
            >
              {tag}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
