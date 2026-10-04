import { describe, expect, test } from "bun:test";
import type { FoliateAnnotation, FoliateView } from "./foliate-engine";
import {
  annotationLine,
  applyNavigatorHighlight,
  navigatorLineBox,
  removeNavigatorHighlight,
} from "./highlight-renderer";

function recordingView() {
  const added: FoliateAnnotation[] = [];
  const removed: FoliateAnnotation[] = [];
  const view = {
    addAnnotation: async (annotation: FoliateAnnotation) => {
      added.push(annotation);
      return undefined;
    },
    deleteAnnotation: async (annotation: FoliateAnnotation) => {
      removed.push(annotation);
    },
  } as unknown as FoliateView;
  return { view, added, removed };
}

describe("navigator overlay identity", () => {
  test("uses a render key distinct from the shared CFI anchor", () => {
    const { view, added } = recordingView();
    const cfiRange = "epubcfi(/6/4!/4/2:0,/4/2:12)";

    applyNavigatorHighlight(view, cfiRange, "#faf9f6");

    expect(added).toEqual([
      {
        value: cfiRange,
        overlayKey: `read-aware:navigator:${cfiRange}`,
        style: "navigator",
        color: "#faf9f6",
      },
    ]);
  });

  test("removes that independent layer without deleting the saved annotation", () => {
    const { view, removed } = recordingView();
    const cfiRange = "epubcfi(/6/4!/4/2:0,/4/2:12)";

    removeNavigatorHighlight(view, cfiRange);

    expect(removed).toEqual([
      {
        value: cfiRange,
        overlayKey: `read-aware:navigator:${cfiRange}`,
      },
    ]);
  });
});

describe("navigator indicator geometry", () => {
  test("adds vertical breathing room without crossing into adjacent text", () => {
    expect(navigatorLineBox({ left: 389.5, top: 1786, width: 646, height: 25 }, 2)).toEqual({
      x: 389.5,
      y: 1784,
      width: 646,
      height: 29,
    });
  });

  test("keeps the inline axis exact in vertical text too", () => {
    expect(navigatorLineBox({ left: 389.5, top: 1786, width: 25, height: 646 }, 2, "vertical-rl")).toEqual({
      x: 387.5,
      y: 1786,
      width: 29,
      height: 646,
    });
  });
});

test("underline and note strokes follow the selected line's writing axis", () => {
  const rect = { left: 10, right: 30, top: 20, bottom: 220, width: 20, height: 200 } as DOMRect;
  expect(annotationLine(rect, "vertical-rl")).toEqual({ x1: 26.8, x2: 26.8, y1: 20.75, y2: 219.25 });
  expect(annotationLine(rect, "vertical-lr")).toEqual({ x1: 13.2, x2: 13.2, y1: 20.75, y2: 219.25 });
  expect(annotationLine(rect)).toEqual({ x1: 10.75, x2: 29.25, y1: 215, y2: 215 });
});
