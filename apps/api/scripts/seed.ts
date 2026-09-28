import "dotenv/config";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { DEFAULT_POST_SETTINGS, DEFAULT_TAGS, slugify } from "@blog/shared";
import { config } from "../src/config.js";
import { db, fullSchema } from "../src/db/index.js";
import { posts, postTags, tags } from "../src/db/schema.js";
import { user } from "../src/db/auth-schema.js";
import { renderPost } from "../src/lib/content/render.js";
import { samplePostOne, samplePostTwo } from "../src/lib/content/sample.js";

// Seed-only Better Auth instance with sign-up enabled, so we can create the
// admin account programmatically even though the public API has sign-up disabled.
const seedAuth = betterAuth({
  baseURL: config.API_ORIGIN,
  secret: config.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema: fullSchema }),
  emailAndPassword: { enabled: true, disableSignUp: false },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
    },
  },
});

async function seedAdmin() {
  const [existing] = await db.select().from(user).where(eq(user.email, config.ADMIN_EMAIL)).limit(1);

  if (existing) {
    if (existing.role !== "admin") {
      await db.update(user).set({ role: "admin" }).where(eq(user.id, existing.id));
    }
    console.log(`Admin allaqachon mavjud: ${config.ADMIN_EMAIL}`);
    return;
  }

  const result = await seedAuth.api.signUpEmail({
    body: {
      email: config.ADMIN_EMAIL,
      password: config.ADMIN_PASSWORD,
      name: "Admin",
    },
  });

  await db.update(user).set({ role: "admin" }).where(eq(user.id, result.user.id));
  console.log(`Admin yaratildi: ${config.ADMIN_EMAIL}`);
}

async function seedTags(): Promise<Map<string, string>> {
  const slugToId = new Map<string, string>();

  for (const tag of DEFAULT_TAGS) {
    const [existing] = await db.select().from(tags).where(eq(tags.slug, tag.slug)).limit(1);

    if (existing) {
      slugToId.set(tag.slug, existing.id);
      continue;
    }

    const [created] = await db
      .insert(tags)
      .values({ slug: tag.slug, name: tag.name })
      .returning();

    if (created) slugToId.set(tag.slug, created.id);
  }

  console.log(`Teglar tayyor: ${slugToId.size} ta`);
  return slugToId;
}

interface SeedPost {
  title: string;
  content: Parameters<typeof renderPost>[0];
  tagSlugs: string[];
  publishedAt: Date;
  pinned?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedPosts(tagIds: Map<string, string>) {
  const seedList: SeedPost[] = [
    {
      title: "Zamonaviy web-stack: Next.js, Hono va Drizzle",
      content: samplePostOne,
      tagSlugs: ["it", "coding"],
      publishedAt: new Date(Date.now() - 2 * DAY_MS),
      pinned: true,
    },
    {
      title: "AI agentlar: kirish va oddiy misol",
      content: samplePostTwo,
      tagSlugs: ["ai", "agents", "llm"],
      publishedAt: new Date(Date.now() - 1 * DAY_MS),
    },
  ];

  for (const item of seedList) {
    const slug = slugify(item.title);
    const [existing] = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);

    if (existing) {
      console.log(`Post allaqachon mavjud: ${slug}`);
      continue;
    }

    const rendered = await renderPost(item.content);

    const [created] = await db
      .insert(posts)
      .values({
        slug,
        title: item.title,
        excerpt: rendered.excerpt,
        contentJson: item.content,
        contentHtml: rendered.html,
        contentText: rendered.text,
        toc: rendered.toc,
        readingTime: rendered.readingTime,
        status: "published",
        publishedAt: item.publishedAt,
        pinned: item.pinned ?? false,
        settings: DEFAULT_POST_SETTINGS,
      })
      .returning();

    if (!created) continue;

    for (const tagSlug of item.tagSlugs) {
      const tagId = tagIds.get(tagSlug);
      if (!tagId) continue;
      await db.insert(postTags).values({ postId: created.id, tagId }).onConflictDoNothing();
    }

    console.log(`Post yaratildi: ${slug}`);
  }
}

// Prod deploy'da 2 ta namunaviy post SHART EMAS — admin va teglar yetarli.
// Default o'zgarmagan (true): dev/local workflow buzilmasligi uchun. Prod'da
// server env'ida SEED_SAMPLE_POSTS=false qo'yiladi.
const SEED_SAMPLE_POSTS = process.env.SEED_SAMPLE_POSTS !== "false";

async function main() {
  await seedAdmin();
  const tagIds = await seedTags();
  if (SEED_SAMPLE_POSTS) {
    await seedPosts(tagIds);
  } else {
    console.log("SEED_SAMPLE_POSTS=false — namunaviy postlar o'tkazib yuborildi.");
  }
  console.log("Seed jarayoni yakunlandi.");
}

main().catch((error: unknown) => {
  console.error("Seed xatosi:", error);
  process.exitCode = 1;
});
