import { describe, expect, spyOn, test } from "bun:test";
import { search, searchAsync, searchMatcher, type SearchOptions, type SearchResult } from "../foliate-js/src/search";
import { indexText } from "../foliate-js/src/text-index";
import { collectTextAsync, readText, textWalker } from "../foliate-js/src/text-walker";
import { withDom } from "./helpers/foliate-dom";

async function collectSearch(strings: string[], query: string, options: SearchOptions = {}, signal?: AbortSignal) {
  const results: SearchResult[] = [];
  for await (const result of searchAsync(strings, query, options, signal)) results.push(result);
  return results;
}

// Expire the scheduling quantum deterministically; timers still run on the real event loop.
async function withExpiredQuantum(run: () => Promise<void>) {
  let time = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => (time += 9));
  try {
    await run();
  } finally {
    clock.mockRestore();
  }
}

describe("text offset index", () => {
  test("keeps boundaries on real nodes, including empty chunks", () => {
    const index = indexText(["", "ab", "", "cd", ""]);
    expect(index.range(0, 2)).toEqual({ startIndex: 1, startOffset: 0, endIndex: 1, endOffset: 2 });
    expect(index.range(2, 4)).toEqual({ startIndex: 3, startOffset: 0, endIndex: 3, endOffset: 2 });
    expect(index.range(1, 3)).toEqual({ startIndex: 1, startOffset: 1, endIndex: 3, endOffset: 1 });
    expect(index.range(2, 2)).toEqual({ startIndex: 3, startOffset: 0, endIndex: 3, endOffset: 0 });
  });
  test("rejects invalid ranges", () => {
    expect(() => indexText([]).range(0, 0)).toThrow(RangeError);
    const index = indexText(["abc"]);
    for (const [start, end] of [
      [-1, 1],
      [2, 1],
      [0, 4],
      [0, NaN],
      [0.5, 1],
    ]) {
      expect(() => index.range(start, end)).toThrow(RangeError);
    }
  });
});

describe("engine search", () => {
  test.each(["variant", "accent", "base", "case"] as const)(
    "finds matches at the end of content (%s)",
    (sensitivity) => {
      const results = [...search(["abc"], "bc", { sensitivity })];
      expect(results).toHaveLength(1);
      expect(results[0].excerpt.match).toBe("bc");
      expect(results[0].range.endOffset).toBe(3);
    },
  );
  test("preserves intermediate nodes in excerpts", () => {
    const results = [...search(["left A", "BCD", "E right"], "ABCDE", { sensitivity: "variant" })];
    expect(results[0].excerpt).toEqual({ pre: "left ", match: "ABCDE", post: " right" });
  });
  test("does not mistake identical endpoint strings for the same node", () => {
    expect([...search(["x", "y", "x"], "xyx")][0].excerpt.match).toBe("xyx");
  });
  test("overlapping matches may start before the preceding match ends", () => {
    const results = [...search(["a", "a", "a", "a"], "aa", { sensitivity: "variant" })];
    expect(results.map((result) => result.range.startIndex)).toEqual([0, 1, 2]);
    expect(results.every((result) => result.excerpt.match === "aa")).toBe(true);
  });
  test("whole words may cross inline element boundaries", () => {
    expect([...search(["hello wo", "rld"], "world", { granularity: "word" })][0].excerpt.match).toBe("world");
    expect([...search(["worldwide"], "world", { granularity: "word" })]).toEqual([]);
  });
  test("whitespace normalization preserves the exact source range", () => {
    const results = [...search(["a \n", "\t b"], "a b")];
    expect(results).toHaveLength(1);
    expect(results[0].excerpt.match).toBe("a \n\t b");
  });
  test("empty queries and content terminate without matches", () => {
    for (const options of [{ sensitivity: "variant" }, { sensitivity: "base" }] satisfies SearchOptions[]) {
      expect([...search([], "a", options)]).toEqual([]);
      expect([...search([""], "a", options)]).toEqual([]);
      expect([...search(["abc"], "", options)]).toEqual([]);
    }
    expect([...search(["abc"], "\u200e")]).toEqual([]);
  });
  test("case, diacritics, Unicode and locale controls remain independent", () => {
    expect([...search(["Café"], "cafe", { sensitivity: "base" })]).toHaveLength(1);
    expect([...search(["Café"], "cafe", { sensitivity: "accent" })]).toHaveLength(0);
    expect([...search(["Café"], "café", { sensitivity: "accent" })]).toHaveLength(1);
    expect([...search(["Café"], "café", { sensitivity: "variant" })]).toHaveLength(0);
    expect([...search(["İx"], "x", { sensitivity: "accent", locales: "en" })][0].range.startOffset).toBe(1);
    expect([...search(["a", "😀", "b"], "😀")][0].range).toEqual({
      startIndex: 1,
      startOffset: 0,
      endIndex: 1,
      endOffset: 2,
    });
    expect([...search(["中文", "阅读"], "阅读", { locales: "zh" })][0].excerpt.match).toBe("阅读");
  });
});

describe("folded search", () => {
  test("matches only whole graphemes and whole source code points", () => {
    // A single member of a ZWJ family is not the family; the joiner is a format character.
    expect([...search(["👨\u200d👩\u200d👧"], "👨")]).toEqual([]);
    expect([...search(["👨\u200d👩\u200d👧"], "👨\u200d👩\u200d👧")]).toHaveLength(1);
    // Accents matter: the base letter alone does not match a precomposed or decomposed accented letter.
    expect([...search(["é e\u0301"], "e", { sensitivity: "accent" })]).toEqual([]);
    expect([...search(["é e\u0301"], "é", { sensitivity: "accent" })].map((r) => r.excerpt.match)).toEqual([
      "é",
      "e\u0301",
    ]);
    // Accents folded: both forms match and the range covers the mark.
    expect([...search(["é e\u0301"], "e", { sensitivity: "base" })].map((r) => r.excerpt.match)).toEqual([
      "é",
      "e\u0301",
    ]);
  });
  test("compatibility forms fold to their plain letters unless the search is exact", () => {
    expect([...search(["Ｃａｆé ﬁne"], "cafe fine", { sensitivity: "base" })]).toHaveLength(1);
    expect([...search(["Ｃａｆé"], "CAFÉ", { sensitivity: "accent" })]).toHaveLength(1);
    expect([...search(["Ｃａｆé"], "Café", { sensitivity: "variant" })]).toEqual([]);
    // The dot above İ is an accent: it survives accent-sensitive folding and falls with base folding.
    expect([...search(["İstanbul"], "istanbul", { sensitivity: "accent", locales: "en" })]).toEqual([]);
    expect(
      [...search(["İstanbul"], "istanbul", { sensitivity: "base", locales: "en" })].map((r) => r.excerpt.match),
    ).toEqual(["İstanbul"]);
  });
  test("whole words respect boundaries after folding and across nodes", () => {
    expect(
      [...search(["Hello WOR", "LD, hello"], "world", { granularity: "word" })].map((r) => r.excerpt.match),
    ).toEqual(["WORLD"]);
    expect([...search(["Worldwide"], "world", { granularity: "word", sensitivity: "base" })]).toEqual([]);
    expect([...search(["a b  c"], "b c", { granularity: "word" })].map((r) => r.excerpt.match)).toEqual(["b  c"]);
  });
  test("a book-length section folds and scans in linear time", () => {
    const filler = "The quick brown fox jumps over the lazy dog while thinking about inheritance. ";
    const text = filler.repeat(4000) + "It is often hard to see the misuse until it is in the rear-view mirror.";
    const started = performance.now();
    const results = [...search([text], "rear-view mirror", { sensitivity: "accent" })];
    const elapsed = performance.now() - started;
    expect(results).toHaveLength(1);
    expect(results[0].range.endOffset).toBe(text.length - 1);
    // The collator window took minutes on 300 KB; folding must stay well under a second.
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("document text walking", () => {
  test("ruby reading text excludes annotations while ranges retain original DOM anchors", () =>
    withDom(async (window) => {
      const doc = window.document;
      doc.body.innerHTML =
        "<p>名前は<ruby>言<rt>こと</rt>万<rt>よろず</rt>心<rt>こと</rt>葉<rp>(</rp><rt>は</rt><rp>)</rp></ruby>です。</p>";
      expect(readText(doc)).toBe("名前は言万心葉です。");
      const hits = [...searchMatcher(textWalker, {})(doc, "言万心葉")];
      expect(hits).toHaveLength(1);
      expect(readText(hits[0].range)).toBe("言万心葉");
      expect(hits[0].range.startContainer).toBe(doc.querySelector("ruby")!.firstChild!);
      expect(
        (
          await collectTextAsync(doc, (node) =>
            node.nodeType === 1 ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
          )
        ).strings.join(""),
      ).toBe("名前は言万心葉です。");
      const rubyOnly = doc.createRange();
      rubyOnly.selectNodeContents(doc.querySelector("rt")!);
      expect(readText(rubyOnly)).toBe("");
      rubyOnly.selectNodeContents(doc.querySelector("rt")!.firstChild!);
      expect(readText(rubyOnly)).toBe("");
    }));
  test("search returns DOM ranges and ignores script/style content", () =>
    withDom((window) => {
      const doc = window.document;
      doc.body.innerHTML = "<script>world</script><style>.world{color:red}</style><p>hello wo<em>rld</em></p>";
      const results = [...searchMatcher(textWalker, { matchWholeWords: true })(doc, "world")];
      expect(results).toHaveLength(1);
      expect(results[0].range.toString()).toBe("world");
      expect(results[0].range.startContainer.ownerDocument).toBe(doc);
    }));
  test("a text-node selection is clipped and maps back to original offsets", () =>
    withDom((window) => {
      const doc = window.document;
      doc.body.textContent = "Hello world!";
      const node = doc.body.firstChild!;
      const range = doc.createRange();
      range.setStart(node, 6);
      range.setEnd(node, 11);
      const results = [
        ...textWalker(range, function* (strings, makeRange) {
          expect(strings).toEqual(["world"]);
          yield makeRange(0, 1, 0, 4);
        }),
      ];
      expect(results[0].toString()).toBe("orl");
      expect(results[0].startOffset).toBe(7);
    }));
  test("multi-node selections clip both edges", () =>
    withDom((window) => {
      const doc = window.document;
      doc.body.innerHTML = "<p>before world <em>and after</em></p>";
      const range = doc.createRange();
      range.setStart(doc.querySelector("p")!.firstChild!, 7);
      range.setEnd(doc.querySelector("em")!.firstChild!, 3);
      expect([
        ...textWalker(range, function* (strings, makeRange) {
          expect(strings).toEqual(["world ", "and"]);
          yield makeRange(0, 0, 1, 3).toString();
        }),
      ]).toEqual(["world and"]);
    }));
});

describe("cooperative content search", () => {
  test("async and sync share Unicode, word, whitespace, overlap and cross-node semantics", async () => {
    for (const sensitivity of ["variant", "accent", "base", "case"] as const) {
      for (const granularity of ["word", "grapheme"] as const) {
        for (const [strings, query] of [
          [["left A", "BCD", "E right"], "ABCDE"],
          [["aaaa"], "aa"],
          [["Café cafe CAFÉ"], "café"],
          [["İx"], "x"],
          [["a", "😀", "b"], "😀"],
          [["中文", "阅读"], "阅读"],
          [["a \n", "\t b"], "a b"],
          [["a\u200eb"], "ab"],
          [["worldwide world"], "world"],
          [["abc"], "\u200e"],
          [[""], "x"],
        ] satisfies Array<[string[], string]>) {
          const options = { sensitivity, granularity };
          expect(await collectSearch(strings, query, options)).toEqual([...search(strings, query, options)]);
        }
      }
    }
  });

  test("bounded substring scans preserve overlapping starts at both sides of a chunk edge", async () => {
    const strings = ["x".repeat(32767) + "aaa", "x".repeat(32767) + "aa"];
    const options = { sensitivity: "variant" } as const;
    const results = await collectSearch(strings, "aa", options);
    expect(results).toEqual([...search(strings, "aa", options)]);
    expect(results.map((result) => [result.range.startIndex, result.range.startOffset])).toEqual([
      [0, 32767],
      [0, 32768],
      [1, 32767],
    ]);
  });

  test("no-hit, whitespace-only and format-only scans accept timer cancellation before completion", () =>
    withExpiredQuantum(async () => {
      for (const text of ["x".repeat(4096), " ".repeat(4096), "\u200e".repeat(4096)]) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 0);
        try {
          await expect(collectSearch([text], "missing", {}, controller.signal)).rejects.toMatchObject({
            name: "AbortError",
          });
        } finally {
          clearTimeout(timer);
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 0);
      try {
        await expect(
          collectSearch(["x".repeat(100000)], "missing", { sensitivity: "variant" }, controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        clearTimeout(timer);
      }
      expect(await collectSearch(["sibling"], "sibling")).toHaveLength(1);
    }));

  test("pre-cancellation reads no content and cancellation after a hit stops the iterator", async () => {
    const strings = new Proxy(["aa"], {
      get() {
        throw new Error("must not read");
      },
    });
    await expect(collectSearch(strings, "a", {}, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    const controller = new AbortController();
    const iterator = searchAsync(["aaaa"], "aa", {}, controller.signal);
    expect((await iterator.next()).value).toMatchObject({ excerpt: { match: "aa" } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect((await iterator.next()).done).toBe(true);
  });

  test("asynchronous DOM collection shares range clipping and script/style filtering", () =>
    withDom(async ({ document: doc }) => {
      doc.body.innerHTML =
        "<script>hidden</script><style>.hidden { color: red }</style><p>before world <em>and after</em></p>";
      const whole = await collectTextAsync(doc);
      expect(whole.strings).toEqual(["before world ", "and after"]);
      const range = doc.createRange();
      range.setStart(doc.querySelector("p")!.firstChild!, 7);
      range.setEnd(doc.querySelector("em")!.firstChild!, 3);
      const clipped = await collectTextAsync(range);
      expect(clipped.strings).toEqual(["world ", "and"]);
      expect(clipped.makeRange(0, 1, 1, 3).toString()).toBe("orld and");
      range.setEnd(range.startContainer, 12);
      const single = await collectTextAsync(range);
      expect(single.strings).toEqual(["world"]);
      expect(single.makeRange(0, 1, 0, 4).startOffset).toBe(8);
    }));

  test("DOM collection yields during traversal and stops before visiting the remaining nodes", () =>
    withDom(async ({ document: doc }) => {
      for (let index = 0; index < 2048; index++) doc.body.append(doc.createTextNode("x"));
      await withExpiredQuantum(async () => {
        let visited = 0;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 0);
        try {
          await expect(
            collectTextAsync(
              doc,
              () => {
                visited++;
                return NodeFilter.FILTER_ACCEPT;
              },
              controller.signal,
            ),
          ).rejects.toMatchObject({ name: "AbortError" });
          expect(visited).toBe(256);
        } finally {
          clearTimeout(timer);
        }
      });
    }));
});
