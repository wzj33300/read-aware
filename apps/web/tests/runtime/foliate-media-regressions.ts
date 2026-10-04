import type { Paginator } from "../../foliate-js/src/paginator";
import { buildReaderContentCss, readerLayoutSpacing } from "../../src/features/settings/lib/reader-css";
import { DEFAULT_READER_SETTINGS, type ReadingMode } from "../../src/features/settings/lib/reader-settings";
import { BUILTIN_READER_PALETTES } from "../../src/features/settings/lib/reader-theme";

type Result = { name: string; passed: boolean; details?: string };

/** Real WebKit columns are essential: DOM mocks cannot reproduce SVG fragments. */
export async function runMediaRegressions(PaginatorClass: typeof Paginator): Promise<Result[]> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("Run this suite inside foreground Tauri");
  const results: Result[] = [];
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const canvas = document.createElement("canvas");
  canvas.width = 465;
  canvas.height = 719;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Missing fixture canvas");
  context.fillStyle = "#753";
  context.fillRect(0, 0, 465, 719);
  const source = canvas.toDataURL();
  const picture = `<img alt="Cover" src="${source}">`;
  const covers = {
    svg: `<div><svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 465 719"><title>Cover artwork</title><image width="465" height="719" href="${source}"/></svg></div>`,
    japanese: `<style>html, body { font-size: 0; margin: 0; padding: 0; }</style><div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 465 719"><image width="465" height="719" xlink:href="${source}"/></svg></div>`,
    table: `<div></div><div>&nbsp;</div><div><table><tr><td>${picture}</td></tr></table></div><div style="page-break-after:always"></div>`,
  };
  const css = (mode: ReadingMode, large = false) =>
    buildReaderContentCss(
      {
        ...DEFAULT_READER_SETTINGS,
        fontFamily: "system:serif",
        readingMode: mode,
        ...(large ? ({ fontSize: "x-large", pageMargins: "narrow" } as const) : {}),
      },
      { palette: BUILTIN_READER_PALETTES.warm },
    );
  const settle = async (doc: Document) => {
    await doc.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };
  const fits = (doc: Document, paginated: boolean) => {
    const image = doc.querySelector("img, svg");
    if (!image) throw new Error("Missing artwork");
    const rects = Array.from(image.getClientRects());
    assert(rects.length === 1, `Artwork fragmented into ${rects.length} columns`);
    const rect = rects[0]!;
    assert(rect.width > 100 && rect.height > 100, "Artwork disappeared or collapsed");
    assert(Math.abs(rect.width / rect.height - 465 / 719) < 0.01, "Artwork aspect ratio changed");
    if (paginated) {
      assert(
        rect.top >= 0 && rect.bottom <= doc.documentElement.clientHeight + 0.5,
        `Artwork exceeds page height: ${JSON.stringify(rect)}`,
      );
      assert(doc.body.getClientRects().length === 1, "Image-only page has an extra blank column");
    }
  };
  const run = async (
    name: string,
    markup: string,
    mode: ReadingMode,
    check: (renderer: Paginator, doc: Document) => Promise<void>,
  ) => {
    const renderer = new PaginatorClass();
    renderer.style.cssText =
      "display:block;position:fixed;left:0;top:0;width:1200px;height:800px;opacity:0;pointer-events:none;z-index:-1";
    document.body.append(renderer);
    const url = URL.createObjectURL(
      new Blob(
        [
          `<!doctype html><html><head><style>table { border-spacing:2px } td { padding:1px }</style></head><body>${markup}</body></html>`,
        ],
        { type: "text/html" },
      ),
    );
    try {
      const spacing = readerLayoutSpacing("wide", mode);
      renderer.setLayoutAttributes({
        flow: mode === "scroll" ? "scrolled" : "paginated",
        margin: spacing.margin,
        gap: spacing.gap,
        "max-column-count": mode === "paginated-double" ? "2" : "1",
        "max-inline-size": "960px",
      });
      renderer.setStyles(css(mode));
      renderer.open({ sections: [{ id: 0, size: 100, load: () => url }] });
      await renderer.goTo({ index: 0 });
      const doc = renderer.getContents()[0]!.doc;
      await settle(doc);
      await check(renderer, doc);
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, details: String(error) });
    } finally {
      renderer.destroy();
      renderer.remove();
      URL.revokeObjectURL(url);
    }
  };

  for (const mode of ["paginated-double", "paginated-single", "scroll"] as const) {
    for (const [kind, markup] of Object.entries(covers)) {
      await run(
        `${mode}: ${kind} cover fits without blank fragments or layout-table borders`,
        markup,
        mode,
        async (renderer, doc) => {
          assert(doc.documentElement.hasAttribute("data-foliate-image-page"), "Image-only document was not recognized");
          fits(doc, mode !== "scroll");
          const cell = doc.querySelector("td");
          if (cell)
            assert(
              doc.defaultView!.getComputedStyle(cell).borderTopWidth === "0px",
              "Cover wrapper has a table border",
            );
          // Typography and dimensions change after the original iframe load.
          renderer.setStyles(css(mode, true));
          await settle(doc);
          fits(doc, mode !== "scroll");
          renderer.style.height = "480px";
          renderer.render();
          await settle(doc);
          fits(doc, mode !== "scroll");
          renderer.style.height = "800px";
          renderer.render();
          await settle(doc);
          fits(doc, mode !== "scroll");
        },
      );
    }
  }
  for (const mode of ["paginated-single", "paginated-double", "scroll"] as const) {
    await run(
      `${mode}: Japanese inline glyphs retain em sizing and paragraph spacing follows the block axis`,
      `<style>html { writing-mode: vertical-rl } img.gaiji { display: inline-block; width: 1em; height: 1em; margin: 0 }</style><p>日本語<img class="gaiji" src="${source}" alt="TM">本文</p><p>次の段落</p>`,
      mode,
      async (_renderer, doc) => {
        const win = doc.defaultView!;
        const image = doc.querySelector("img")!;
        const style = win.getComputedStyle(image);
        const size = parseFloat(win.getComputedStyle(doc.body).fontSize);
        assert(style.display === "inline-block", "Inline glyph became a block illustration");
        assert(Math.abs(image.getBoundingClientRect().width - size) < 1, "Inline glyph lost its em width");
        assert(Math.abs(image.getBoundingClientRect().height - size) < 1, "Inline glyph lost its em height");
        const paragraph = win.getComputedStyle(doc.querySelector("p")!);
        assert(paragraph.marginBlockEnd === "20px", "Paragraph spacing missed the vertical block axis");
        assert(paragraph.marginInlineEnd === "0px", "Paragraph spacing shortened the vertical line");
      },
    );
  }
  await run(
    "ordinary illustrations reserve their margins and data tables keep their borders",
    `<figure>${picture}<figcaption>Figure caption</figcaption></figure><table><tr><td>Actual data</td></tr></table>`,
    "paginated-double",
    async (renderer, doc) => {
      assert(!doc.documentElement.hasAttribute("data-foliate-image-page"), "Text page was mistaken for a cover");
      const img = doc.querySelector("img")!;
      const limit = () => parseFloat(img.style.maxHeight);
      const before = limit();
      assert(img.getClientRects().length === 1, "Ordinary illustration fragmented");
      assert(
        doc.defaultView!.getComputedStyle(doc.querySelector("td")!).borderTopWidth === "1px",
        "Data table lost its border",
      );
      assert(
        doc.defaultView!.getComputedStyle(doc.querySelector("figcaption")!).display !== "none",
        "Caption was hidden",
      );
      renderer.setStyles(
        `${css("paginated-double")} body { padding-top: 100px !important; } img { margin-block: 40px !important; }`,
      );
      await settle(doc);
      assert(limit() < before - 80, "Image size did not respond to changed content spacing");
      assert(img.getClientRects().length === 1, "Style update split the illustration");
      const current = limit();
      renderer.render();
      renderer.render();
      assert(limit() === current, "Repeated layout progressively shrinks the image");
    },
  );
  return results;
}
