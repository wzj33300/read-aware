import type { View, DrawAnnotationDetail, ShowAnnotationDetail } from "../../foliate-js/src/view";
import { buildReaderContentCss, readerLayoutSpacing } from "../../src/features/settings/lib/reader-css";
import { DEFAULT_READER_SETTINGS } from "../../src/features/settings/lib/reader-settings";
import { BUILTIN_READER_PALETTES } from "../../src/features/settings/lib/reader-theme";
import { readingScrollDelta } from "../../src/features/reader/lib/wheel-gesture";

/** Use real fragmentation, frame coordinates and CFI anchors for Japanese spreads. */
export async function runVerticalRegressions(ViewClass: typeof View) {
  const results: { name: string; passed: boolean; details?: string }[] = [];
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const visibleCharacter = (doc: Document) => {
    const frame = doc.defaultView!.frameElement!.getBoundingClientRect();
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || node.parentElement?.closest("rt, rp, script, style")) continue;
      for (let offset = 0; offset < node.textContent.length; offset++) {
        if (!node.textContent[offset].trim()) continue;
        const range = doc.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && frame.top + rect.top > 20 && frame.top + rect.bottom < 780) return range;
      }
    }
    throw new Error("Page contains no visible reading text");
  };
  for (const rootVertical of [true, false]) {
    const view = new ViewClass();
    view.style.cssText = "display:block;position:fixed;left:0;top:0;width:1200px;height:800px";
    document.body.append(view);
    const markup = `<!doctype html><html><head><style>${rootVertical ? "html" : "body"} { writing-mode:vertical-rl } .tcy { text-combine-upright:all }</style></head><body>${Array.from({ length: 70 }, (_, i) => `<p>第<span class="tcy">${i}</span>段。<ruby>言<rt>こと</rt>万<rt>よろず</rt>心<rt>こと</rt>葉<rt>は</rt></ruby>。${"日本語の縦書きを読む。".repeat(12)}</p>`).join("")}</body></html>`;
    const url = URL.createObjectURL(new Blob([markup], { type: "text/html" }));
    const name = `${rootVertical ? "root" : "body"} vertical-rl: side-by-side pages, annotations, CFI, resize and wheel provenance`;
    try {
      await view.open({
        dir: "rtl",
        metadata: { language: "ja" },
        sections: [
          {
            id: 0,
            size: markup.length,
            load: () => url,
            createDocument: () => new DOMParser().parseFromString(markup, "text/html"),
          },
        ],
      });
      const renderer = view.renderer;
      if (!renderer || !("setLayoutAttributes" in renderer)) throw new Error("Missing paginator");
      const spacing = readerLayoutSpacing("wide", "paginated-double");
      renderer.setLayoutAttributes({
        flow: "paginated",
        "max-column-count": "2",
        "max-inline-size": "960px",
        gap: spacing.gap,
        margin: spacing.margin,
      });
      renderer.setStyles(
        buildReaderContentCss(
          { ...DEFAULT_READER_SETTINGS, fontFamily: "system:serif", readingMode: "paginated-double" },
          { palette: BUILTIN_READER_PALETTES.warm },
        ),
      );
      await view.goTo(0);
      await renderer.waitForCurrentRender();
      const contents = renderer.getContents();
      assert(contents.length === 2, "Wide vertical spread needs two pages");
      const [right, left] = contents;
      const rightFrame = right.doc.defaultView!.frameElement!.getBoundingClientRect();
      const leftFrame = left.doc.defaultView!.frameElement!.getBoundingClientRect();
      assert(rightFrame.left > leftFrame.right, "Pages are not arranged right then left with a gutter");
      const rightRange = visibleCharacter(right.doc),
        leftRange = visibleCharacter(left.doc);
      const rightCFI = view.getCFI(0, rightRange),
        leftCFI = view.getCFI(0, leftRange);
      assert(rightCFI !== leftCFI, "Both pages display the same source fragment");
      assert(view.getTextRange(0, leftRange).cfi === leftCFI, "Left-page selection lost its source identity");
      const drawn = new Set<Document>();
      view.addEventListener("draw-annotation", (event) =>
        drawn.add((event as CustomEvent<DrawAnnotationDetail>).detail.doc),
      );
      await view.addAnnotation({ value: leftCFI });
      assert(drawn.has(right.doc) && drawn.has(left.doc), "Annotation was not applied to both source frames");
      const first = view.lastLocation!.cfi;
      renderer.scrollBy(-1200, 0);
      renderer.snap(-1, 0);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      assert(view.lastLocation!.cfi !== first, "Rightward page drag did not advance the vertical spread");
      await view.goTo(first);
      await view.next();
      assert(view.lastLocation!.cfi !== first, "Next spread did not advance");
      await view.goTo(leftCFI);
      assert(view.lastLocation!.cfi === first, "Restoring a left-page CFI did not restore its spread");
      await view.select(leftCFI);
      assert(
        left.doc.getSelection()?.toString() === view.readText(leftRange),
        "Programmatic selection used an invisible page copy",
      );
      let annotationDoc: Document | null = null;
      view.addEventListener("show-annotation", (event) => {
        annotationDoc = (event as CustomEvent<ShowAnnotationDetail>).detail.range.startContainer.ownerDocument;
      });
      await view.showAnnotation({ value: leftCFI });
      assert(annotationDoc === left.doc, "Annotation menu used an invisible page copy");
      assert(!view.readText(view.lastLocation!.range!).includes("よろず"), "Visible text includes ruby readings");
      view.style.width = "600px";
      renderer.render();
      await renderer.waitForCurrentRender();
      assert(renderer.getContents().length === 1, "Portrait layout kept a duplicate page");
      view.style.width = "1200px";
      renderer.render();
      await renderer.waitForCurrentRender();
      assert(renderer.getContents().length === 2, "Wide layout did not restore its spread");
      renderer.setLayoutAttributes({ flow: "scrolled" });
      await renderer.waitForCurrentRender();
      assert(renderer.getContents().length === 1, "Scroll flow kept the spread mirror");
      await view.goTo(0);
      const context = { wheel: "vertical-book" };
      let feedback: object | undefined;
      renderer.addEventListener("relocate", (event) => {
        feedback = (event as CustomEvent<{ context: object }>).detail.context;
      });
      await renderer.scrollByReading(readingScrollDelta(0, 240, true), context);
      assert(renderer.start > 0, "Vertical wheel did not move along the reading axis");
      assert(feedback === context, "Axis translation lost its input provenance");
      const start = renderer.start;
      await renderer.scrollByReading(readingScrollDelta(120, 0, true), context);
      assert(renderer.start < start, "Rightward horizontal input did not move backward");
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, details: String(error) });
    } finally {
      await view.close();
      view.remove();
      URL.revokeObjectURL(url);
    }
  }
  return results;
}
