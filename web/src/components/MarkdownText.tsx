import { lazy, memo, Suspense } from "react";

const load = () => import("./Markdown");
const Markdown = lazy(load);

/** warm the markdown chunk (called once the chat shell mounts) */
export const preloadMarkdown = () => {
  void load();
};

/**
 * Memoized markdown block — re-parses only when its own text changes,
 * so earlier parts of a streaming reply don't re-render per delta.
 * Falls back to plain pre-wrapped text until the parser chunk loads.
 */
export const MarkdownText = memo(function MarkdownText({
  text,
  className = "md"
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Suspense fallback={<p className="whitespace-pre-wrap">{text}</p>}>
        <Markdown text={text} />
      </Suspense>
    </div>
  );
});
