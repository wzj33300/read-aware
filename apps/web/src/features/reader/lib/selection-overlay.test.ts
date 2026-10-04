import { expect, test } from "bun:test";
import { withDom } from "../../../../tests/helpers/foliate-dom";
import { readText } from "../../../../foliate-js/src/text-walker";
import { getNormalizedSelectionText, getSelectionContext } from "./selection-overlay";
import { readingScrollDelta } from "./wheel-gesture";

test("selection and dictionary context share ruby-free reading text", () =>
  withDom(({ document: doc }) => {
    doc.body.innerHTML = "<p>名前は<ruby>言<rt>こと</rt>万<rt>よろず</rt>心<rt>こと</rt>葉<rt>は</rt></ruby>です。</p>";
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("ruby")!);
    const selection = doc.getSelection()!;
    selection.addRange(range);
    expect(getNormalizedSelectionText(selection, readText)).toBe("言万心葉");
    expect(getSelectionContext(range, "言万心葉", readText)).toBe("名前は言万心葉です。");
  }));

test("vertical scroll input converts both wheel axes to reading-forward travel", () => {
  expect(readingScrollDelta(0, 60, true)).toBe(60);
  expect(readingScrollDelta(-60, 0, true)).toBe(60);
  expect(readingScrollDelta(60, 3, true)).toBe(-60);
  expect(readingScrollDelta(-60, 0, false)).toBe(0);
  expect(readingScrollDelta(0, -60, false)).toBe(-60);
  // Touch deltas are previous pointer position minus the current position.
  // Dragging right reveals the next vertical-rl columns to the left.
  expect(readingScrollDelta(100 - 160, 0, true)).toBe(60);
  expect(readingScrollDelta(160 - 100, 0, true)).toBe(-60);
});
