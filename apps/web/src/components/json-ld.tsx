import { serializeJsonLd } from "@/lib/json-ld";

/** Server komponent: JSON-LD'ni xavfsiz serialize qilib `<script>`ga joylaydi. */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
