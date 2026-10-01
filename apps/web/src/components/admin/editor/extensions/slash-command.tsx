"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Extension, type Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { availableBlockItems, filterBlockItems, type BlockItem } from "../block-items";
import { cn } from "@/lib/utils";

type MenuProps = SuggestionProps<BlockItem, BlockItem>;

interface MenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const SlashMenuList = forwardRef<MenuHandle, MenuProps>(function SlashMenuList({ items, command }, ref) {
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSelected(0), [items]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (items.length === 0) return event.key === "Enter" || event.key === "Tab";
      if (event.key === "ArrowDown") {
        setSelected((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return <div className="slash-menu"><p className="slash-menu-empty">Hech narsa topilmadi</p></div>;
  }

  return (
    <div className="slash-menu" role="listbox" aria-label="Blok qo'shish" ref={listRef}>
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === selected}
            data-selected={index === selected}
            data-testid={`slash-item-${item.id}`}
            className={cn("slash-menu-item", index === selected && "is-selected")}
            onMouseDown={(event) => {
              event.preventDefault();
              command(item);
            }}
            onMouseMove={() => setSelected(index)}
          >
            <span className="slash-menu-icon"><Icon className="size-4" /></span>
            <span className="slash-menu-text">
              <span className="slash-menu-title">{item.title}</span>
              <span className="slash-menu-desc">{item.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
});

export interface SlashStorage {
  /** "+" tugmasi ochgan bo'lsa — yopilganda "/" qoldig'i har doim o'chiriladi. */
  fromPlus: boolean;
}

export function openSlashMenuFromPlus(editor: Editor): void {
  (editor.storage as unknown as { slashCommand: SlashStorage }).slashCommand.fromPlus = true;
  editor.chain().focus().insertContent("/").run();
}

export const SlashCommand = Extension.create<Record<string, never>, SlashStorage>({
  name: "slashCommand",
  addStorage() {
    return { fromPlus: false };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const storage = this.storage;
    return [
      Suggestion<BlockItem, BlockItem>({
        editor,
        char: "/",
        startOfLine: false,
        items: ({ query }) => filterBlockItems(availableBlockItems(editor), query),
        command: ({ editor: ed, range, props }) => {
          ed.chain().focus().deleteRange(range).run();
          props.run(ed);
        },
        render: () => {
          let renderer: ReactRenderer<MenuHandle, MenuProps> | null = null;
          let unmount: (() => void) | null = null;
          let executed = false;
          let escaped = false;
          const onKeyCapture = (event: KeyboardEvent) => {
            escaped = event.key === "Escape";
          };
          return {
            onStart: (props) => {
              executed = false;
              escaped = false;
              const origCommand = props.command;
              renderer = new ReactRenderer(SlashMenuList, {
                editor: props.editor,
                props: {
                  ...props,
                  command: (item: BlockItem) => {
                    executed = true;
                    origCommand(item);
                  },
                },
              });
              props.editor.view.dom.addEventListener("keydown", onKeyCapture, true);
              unmount = props.mount(renderer.element as HTMLElement);
            },
            onUpdate: (props) => {
              const origCommand = props.command;
              renderer?.updateProps({
                ...props,
                command: (item: BlockItem) => {
                  executed = true;
                  origCommand(item);
                },
              });
            },
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (props.event.key === "Escape") {
                escaped = true;
                return true;
              }
              return renderer?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: (props) => {
              props.editor.view.dom.removeEventListener("keydown", onKeyCapture, true);
              const ed = props.editor;
              const stillThere = !ed.isDestroyed && ed.state.doc.textBetween(props.range.from, Math.min(props.range.to, ed.state.doc.content.size), "\n", "\n") === props.text;
              // Escape — har doim tozalaydi; "+" ochgan bo'lsa — buyruqsiz yopilganda ham. Aks holda
              // (masalan "a / b" da bo'shliq bosildi) foydalanuvchining "/" belgisiga tegilmaydi.
              if (!executed && stillThere && (escaped || storage.fromPlus)) {
                ed.chain().deleteRange(props.range).run();
              }
              storage.fromPlus = false;
              unmount?.();
              unmount = null;
              renderer?.destroy();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});
