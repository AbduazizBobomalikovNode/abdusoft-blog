import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";

export interface SlashCommandItem {
  title: string;
  command: (props: { editor: Editor; range: Range }) => void;
}

const CALLOUT_MARKERS = ["ℹ️", "⚠️", "💡"] as const;

function insertCallout(editor: Editor, range: Range, marker: string) {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .toggleBlockquote()
    .insertContent(`${marker} `)
    .run();
}

function buildItems(): SlashCommandItem[] {
  return [
    {
      title: "Sarlavha 2",
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
    },
    {
      title: "Sarlavha 3",
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
    },
    {
      title: "Kod bloki",
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode("codeBlock").run(),
    },
    {
      title: "Rasm",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        window.dispatchEvent(new CustomEvent("post-editor:insert-image"));
      },
    },
    {
      title: "Iqtibos",
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      title: "Callout — ma'lumot (ℹ️)",
      command: ({ editor, range }) => insertCallout(editor, range, CALLOUT_MARKERS[0]),
    },
    {
      title: "Callout — ogohlantirish (⚠️)",
      command: ({ editor, range }) => insertCallout(editor, range, CALLOUT_MARKERS[1]),
    },
    {
      title: "Callout — maslahat (💡)",
      command: ({ editor, range }) => insertCallout(editor, range, CALLOUT_MARKERS[2]),
    },
    {
      title: "Ro'yxat",
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      title: "Raqamli ro'yxat",
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      title: "Jadval",
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      title: "Ajratgich",
      command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
  ];
}

function renderMenu() {
  let popup: HTMLDivElement | null = null;
  let unmount: (() => void) | null = null;
  let items: SlashCommandItem[] = [];
  let selectedIndex = 0;
  let latestProps: SuggestionProps<SlashCommandItem, SlashCommandItem> | null = null;

  function paint() {
    if (!popup) return;
    popup.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "slash-menu-empty";
      empty.textContent = "Hech narsa topilmadi";
      popup.appendChild(empty);
      return;
    }

    items.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `slash-menu-item${index === selectedIndex ? " is-selected" : ""}`;
      button.textContent = item.title;
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        latestProps?.command(item);
      });
      popup?.appendChild(button);
    });
  }

  return {
    onStart: (props: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      latestProps = props;
      items = props.items;
      selectedIndex = 0;
      popup = document.createElement("div");
      popup.className = "slash-menu";
      paint();
      unmount = props.mount(popup);
    },
    onUpdate: (props: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      latestProps = props;
      items = props.items;
      selectedIndex = 0;
      paint();
    },
    onKeyDown: (props: SuggestionKeyDownProps): boolean => {
      if (props.event.key === "Escape") {
        // Popupni bu yerda o'chirmaymiz: kutubxona Escape'dan keyin har doim
        // `dispatchExit` chaqiradi, u esa pastdagi `onExit`ni ishga tushiradi —
        // aynan o'sha yerda "/query" matnini o'chirish (yoki qoldirish) mantiqi bor.
        return true;
      }
      if (props.event.key === "ArrowDown") {
        selectedIndex = (selectedIndex + 1) % Math.max(items.length, 1);
        paint();
        return true;
      }
      if (props.event.key === "ArrowUp") {
        selectedIndex = (selectedIndex - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1);
        paint();
        return true;
      }
      if (props.event.key === "Enter") {
        const item = items[selectedIndex];
        if (item) latestProps?.command(item);
        return true;
      }
      return false;
    },
    onExit: (props: SuggestionProps<SlashCommandItem, SlashCommandItem>) => {
      // Escape yoki tashqariga bosish orqali chiqishda hali buyruq tanlanmagan
      // bo'lsa, "/query" matni hujjatda qoladi (ko'rinadigan "/" sifatida).
      // Agar biror buyruq allaqachon bajarilgan bo'lsa, o'sha buyruqning o'zi
      // `deleteRange(range)` qilib ulgurgan bo'ladi — shu holatda range ichidagi
      // matn endi asl "/query"ga teng emas, shuning uchun bu yerda uni qayta
      // o'chirish (va yangi kiritilgan kontentni yeyish) xavfsiz tekshiruv bilan
      // oldini olinadi.
      const { editor, range, text } = props;
      const currentText = editor.state.doc.textBetween(range.from, range.to, "\n", "\n");
      if (currentText === text) {
        editor.chain().deleteRange(range).run();
      }
      unmount?.();
      popup = null;
    },
  };
}

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        items: ({ query }) => {
          const all = buildItems();
          if (!query) return all;
          return all.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
        },
        command: ({ editor, range, props }) => {
          props.command({ editor, range });
        },
        render: renderMenu,
      }),
    ];
  },
});
