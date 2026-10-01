"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import type { TagWithCount } from "@blog/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function TagMultiselect({
  allTags,
  selectedSlugs,
  onChange,
}: {
  allTags: TagWithCount[];
  selectedSlugs: string[];
  onChange: (slugs: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedTags = allTags.filter((tag) => selectedSlugs.includes(tag.slug));

  function toggle(slug: string) {
    if (selectedSlugs.includes(slug)) {
      onChange(selectedSlugs.filter((s) => s !== slug));
    } else {
      onChange([...selectedSlugs, slug]);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal max-md:h-11"
          >
            {selectedTags.length > 0 ? `${selectedTags.length} ta teg tanlangan` : "Teglarni tanlang"}
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Teg qidirish…" className="max-md:h-11" />
            <CommandList>
              <CommandEmpty>Teg topilmadi.</CommandEmpty>
              <CommandGroup>
                {allTags.map((tag) => (
                  <CommandItem key={tag.id} value={tag.name} className="max-md:min-h-11" onSelect={() => toggle(tag.slug)}>
                    <Check
                      className={cn(
                        "size-4",
                        selectedSlugs.includes(tag.slug) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {tag.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedTags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedTags.map((tag) => (
            <Badge key={tag.id} variant="secondary" className="gap-1 max-md:h-11 max-md:pr-1 max-md:pl-3 max-md:text-sm">
              {tag.name}
              <button
                type="button"
                onClick={() => toggle(tag.slug)}
                aria-label={`${tag.name} tegini olib tashlash`}
                className="max-md:flex max-md:size-11 max-md:-my-1 max-md:items-center max-md:justify-center"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
