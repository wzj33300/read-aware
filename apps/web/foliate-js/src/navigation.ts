import type { Anchor, BookMetadata, ResolvedNavigation } from "./book.js";

// DOM objects belong to the section iframe's realm, not necessarily this one.
export const isRange = (anchor: Anchor): anchor is Range => typeof anchor !== "number" && "startContainer" in anchor;
export const anchorValue = (doc: Document, anchor: ResolvedNavigation["anchor"]) =>
  typeof anchor === "function" ? anchor(doc) : anchor;
const isElement = (value: unknown): value is Element =>
  value != null &&
  typeof value === "object" &&
  "nodeType" in value &&
  value.nodeType === 1 &&
  "closest" in value &&
  typeof value.closest === "function";
export const anchorElement = (anchor: Anchor | null | undefined): Element | null => {
  if (anchor == null || typeof anchor === "number") return null;
  if (!isRange(anchor)) return anchor;
  const node = anchor.startContainer;
  return isElement(node) ? node : node.parentElement;
};
export const anchorRange = (doc: Document, anchor: Anchor | null | undefined): Range | null => {
  if (anchor == null || typeof anchor === "number") return null;
  if (isRange(anchor)) return anchor;
  const range = doc.createRange();
  range.selectNodeContents(anchor);
  return range;
};
/** Visibility of a source anchor after its iframe has been positioned/scaled. */
export const anchorIsVisible = (doc: Document, anchor: Range | Element, viewport: Element): boolean => {
  const frame = doc.defaultView?.frameElement;
  if (!frame) return false;
  const bounds = viewport.getBoundingClientRect(),
    box = frame.getBoundingClientRect();
  const scale = frame.clientWidth ? box.width / frame.clientWidth : 1;
  return Array.from(anchor.getClientRects()).some(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      box.left + rect.right * scale > bounds.left &&
      box.left + rect.left * scale < bounds.right &&
      box.top + rect.bottom * scale > bounds.top &&
      box.top + rect.top * scale < bounds.bottom,
  );
};
export const eventElement = (target: EventTarget | null): Element | null => {
  if (isElement(target)) return target;
  if (target && "parentElement" in target && isElement(target.parentElement)) return target.parentElement;
  return null;
};

export type LanguageInfo = { canonical?: string; locale?: Intl.Locale; isCJK?: boolean; direction?: string };
export const languageInfo = (lang: BookMetadata["language"]): LanguageInfo => {
  if (!lang) return {};
  try {
    const canonical = Intl.getCanonicalLocales(lang)[0];
    if (!canonical) return {};
    const locale = new Intl.Locale(canonical);
    const platformLocale = locale as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    return {
      canonical,
      locale,
      isCJK: ["zh", "ja", "ko"].includes(locale.language),
      direction: (platformLocale.getTextInfo?.() ?? platformLocale.textInfo)?.direction,
    };
  } catch (error) {
    console.warn("Invalid book language", error);
    return {};
  }
};
