import type { JSONContent } from "@tiptap/core";

/**
 * Namunaviy Tiptap JSON hujjati (o'zbek tilida) — postlarni urug'lash uchun.
 */
export const samplePostOne: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Kirish" }] },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Ushbu maqolada zamonaviy veb-ilovalarni qurishda ishlatiladigan asosiy yondashuvlar haqida so'z boradi. Biz Next.js, Hono va Drizzle ORM kombinatsiyasini ko'rib chiqamiz.",
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Nega bu stack?" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Chunki u tez, ishonchli va " },
        { type: "text", marks: [{ type: "bold" }], text: "type-safe" },
        {
          type: "text",
          text: ". Quyida oddiy TypeScript kod namunasi keltirilgan:",
        },
      ],
    },
    {
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [
        {
          type: "text",
          text: "export function greet(name: string): string {\n  return `Salom, ${name}!`;\n}\n\nconsole.log(greet(\"dunyo\"));",
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Rasm bilan tushuntirish" }],
    },
    {
      type: "image",
      attrs: {
        src: "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=1200",
        alt: "Kod yozish jarayoni",
        title: "Kod yozish jarayoni",
      },
    },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "“Soddalik — bu murakkablikning eng yuqori shakli.”",
            },
          ],
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Asosiy fikrlar" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Server komponentlar tezlikni oshiradi" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Drizzle ORM SQL'ga yaqin va tushunarli" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Hono — bu " },
                {
                  type: "text",
                  marks: [{ type: "link", attrs: { href: "https://hono.dev", target: "_blank" } }],
                  text: "juda tez",
                },
                { type: "text", text: " web freymvork" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export const samplePostTwo: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "AI agentlar nima?" }] },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "AI agentlar — bu maqsadga erishish uchun mustaqil qaror qabul qiladigan, vositalardan (tools) foydalana oladigan dasturiy tizimlar. Ular LLM (Large Language Model) asosida ishlaydi.",
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Oddiy misol" }],
    },
    {
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [
        {
          type: "text",
          text: "type Agent = {\n  name: string;\n  run(task: string): Promise<string>;\n};\n\nconst agent: Agent = {\n  name: \"yordamchi\",\n  async run(task) {\n    return `Bajarildi: ${task}`;\n  },\n};",
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Kelajakda robotlar va AGI mavzulariga ham to'xtalamiz.",
        },
      ],
    },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "“Kelajak allaqachon shu yerda — u shunchaki notekis taqsimlangan.”" },
          ],
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Foydali havolalar" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "LLM arxitekturasi haqida ko'proq o'qing" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Agentlar uchun tool-calling namunalari" }],
            },
          ],
        },
      ],
    },
  ],
};
