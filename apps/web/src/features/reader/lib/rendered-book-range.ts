import { AppError, type BookTextRange, type ReadingTextQuote } from "@read-aware/core";
import type { FoliateView } from "./foliate-engine";
import { measureSectionToRoot, visibleFrameRectInRoot } from "./frame-geometry";

/** Resolve a validated source range against its own currently rendered document. */
export function renderedBookRange(
  view: FoliateView,
  target: BookTextRange,
  resolveTextQuote: (doc: Document, quote: ReadingTextQuote) => Range,
) {
  try {
    const resolved = view.resolveCFI(target.cfi);
    const contents = view.renderer?.getContents().filter((content) => content.index === resolved.index) ?? [];
    const candidates = contents.map((content) => {
      const anchor =
        typeof resolved.anchor === "function"
          ? resolved.anchor(content.doc)
          : target.textQuote
            ? resolveTextQuote(content.doc, target.textQuote)
            : resolved.anchor;
      if (
        !anchor ||
        typeof anchor === "number" ||
        !("commonAncestorContainer" in anchor) ||
        anchor.collapsed ||
        anchor.startContainer.ownerDocument !== content.doc ||
        anchor.endContainer.ownerDocument !== content.doc
      ) {
        throw new Error("A nonempty range in the rendered document is required");
      }
      return { content, range: anchor };
    });
    // A reflowable spread can expose the same source in two frames. Select
    // the visible copy so programmatic selections and menus land on the page.
    return (
      candidates.find(({ content, range }) => {
        if (candidates.length === 1) return true;
        const mapping = measureSectionToRoot(content.doc, view.renderer);
        return mapping && Array.from(range.getClientRects()).some((rect) => visibleFrameRectInRoot(rect, mapping));
      }) ??
      candidates[0] ??
      null
    );
  } catch (cause) {
    throw new AppError("reader/target-not-found", "Source range no longer resolves uniquely in the rendered document", {
      cause,
    });
  }
}
