import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[680px] flex-1 px-4 py-8">
        <div className="flex flex-col items-start gap-3 py-12">
          <p className="font-mono text-sm text-muted-foreground">404</p>
          <h1 className="text-2xl font-semibold tracking-tight">Bu sahifa topilmadi</h1>
          <p className="text-sm text-muted-foreground">
            Qidirgan narsangiz ko&apos;chib ketgan, o&apos;chirilgan yoki umuman mavjud emas.
          </p>
          <Link href="/" className="text-sm text-primary underline underline-offset-4">
            Bosh sahifaga qaytish
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
