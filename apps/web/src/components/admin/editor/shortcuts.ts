export interface ShortcutRow {
  keys: string;
  label: string;
}
export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "Mod+Shift+F" → "⌘⇧F" (Mac) yoki "Ctrl+Shift+F". */
export function formatShortcut(keys: string): string {
  const mac = isMac();
  return keys
    .split("+")
    .map((k) => {
      if (k === "Mod") return mac ? "⌘" : "Ctrl";
      if (k === "Shift") return mac ? "⇧" : "Shift";
      if (k === "Alt") return mac ? "⌥" : "Alt";
      if (k === "Up") return "↑";
      if (k === "Down") return "↓";
      return k;
    })
    .join(mac ? "" : "+");
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Matn",
    rows: [
      { keys: "Mod+B", label: "Qalin" },
      { keys: "Mod+I", label: "Kursiv" },
      { keys: "Mod+U", label: "Tagiga chizilgan" },
      { keys: "Mod+Shift+S", label: "Ustidan chizilgan" },
      { keys: "Mod+E", label: "Satr ichidagi kod" },
      { keys: "Mod+K", label: "Havola qo'shish / tahrirlash" },
      { keys: "Mod+Z", label: "Ortga" },
      { keys: "Mod+Shift+Z", label: "Qayta bajarish" },
    ],
  },
  {
    title: "Bloklar",
    rows: [
      { keys: "Mod+Alt+0", label: "Oddiy matn" },
      { keys: "Mod+Alt+2", label: "Sarlavha 2" },
      { keys: "Mod+Alt+3", label: "Sarlavha 3" },
      { keys: "Mod+Shift+8", label: "Ro'yxat" },
      { keys: "Mod+Shift+7", label: "Raqamli ro'yxat" },
      { keys: "Mod+Shift+B", label: "Iqtibos" },
      { keys: "Mod+Alt+C", label: "Kod bloki" },
      { keys: "Alt+Up", label: "Blokni yuqoriga siljitish" },
      { keys: "Alt+Down", label: "Blokni pastga siljitish" },
      { keys: "/", label: "Blok qo'shish menyusi" },
    ],
  },
  {
    title: "Kod bloki va jadval",
    rows: [
      { keys: "Tab", label: "Kodda: surish; jadvalda: keyingi katak" },
      { keys: "Shift+Tab", label: "Kodda: qaytarish; jadvalda: oldingi katak" },
      { keys: "Mod+Enter", label: "Kod blokidan chiqish" },
    ],
  },
  {
    title: "Markdown yozuvi",
    rows: [
      { keys: "## ", label: "Sarlavha 2 (### — Sarlavha 3)" },
      { keys: "- ", label: "Ro'yxat (1. — raqamli)" },
      { keys: "> ", label: "Iqtibos" },
      { keys: "```", label: "Kod bloki" },
      { keys: "---", label: "Ajratgich" },
      { keys: "**matn**", label: "Qalin (*matn* — kursiv, `kod`)" },
    ],
  },
  {
    title: "Umumiy",
    rows: [
      { keys: "Mod+S", label: "Hoziroq saqlash" },
      { keys: "Mod+Shift+F", label: "Diqqat rejimi" },
      { keys: "Mod+/", label: "Shu oynani ochish" },
      { keys: "Esc", label: "Menyu / diqqat rejimidan chiqish" },
    ],
  },
];
