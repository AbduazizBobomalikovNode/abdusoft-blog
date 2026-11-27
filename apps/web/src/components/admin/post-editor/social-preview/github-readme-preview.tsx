"use client";

import { useState } from "react";
import { BookOpen } from "lucide-react";
import { PreviewFrame } from "./parts";
import { parseReadmeBlock } from "./text";

export const README_START_MARKER = "<!-- BLOG-POSTS:START -->";
export const README_END_MARKER = "<!-- BLOG-POSTS:END -->";

export function GitHubReadmePreview({ block }: { block: string }) {
  const [raw, setRaw] = useState(false);
  const lines = parseReadmeBlock(block);
  return (
    <PreviewFrame label="GitHub README" testId="social-preview-github">
      <div className="-m-3 overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">
          <span className="flex items-center gap-1.5 font-semibold"><BookOpen className="size-3.5" aria-hidden />README.md</span>
          <button type="button" data-testid="social-github-raw-toggle" className="text-neutral-500 underline dark:text-neutral-400" onClick={() => setRaw((v) => !v)}>{raw ? "Ko'rinish" : "Xom blok"}</button>
        </div>
        {raw ? (
          <pre className="max-h-64 overflow-auto px-3 py-3 font-mono text-xs break-words whitespace-pre-wrap" data-testid="social-github-raw">{`${README_START_MARKER}\n${block}\n${README_END_MARKER}`}</pre>
        ) : (
          <div className="px-4 py-3">
            <h3 className="mb-2 border-b border-neutral-200 pb-1 text-base font-semibold dark:border-neutral-700">So&apos;nggi maqolalar</h3>
            {lines.length === 0 ? <p className="text-xs text-neutral-500">Blok bo&apos;sh…</p> : (
              <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="social-github-list">
                {lines.map((l, i) => (
                  <li key={i}>
                    {l.kind === "link" ? <><span className="text-sky-600 dark:text-sky-400">{l.title}</span>{l.rest ? <span className="text-neutral-500"> {l.rest}</span> : null}</> : l.title}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </PreviewFrame>
  );
}
