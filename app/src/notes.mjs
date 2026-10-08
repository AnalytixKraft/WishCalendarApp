/* The notebook's rules, shared by the database and the pages: how long a
 * note may be, what counts as a #tag, and how words typed in the search box
 * become a full-text query. */

export const MAX_TITLE = 200;
export const MAX_BODY = 100_000;

/* A link in a note: http(s) only, so a "javascript:" can never be one. */
export const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/g;

/* Punctuation that ends a sentence, not the link it follows. */
export const trimUrl = (url) => url.replace(/[.,!?;:)\]}'"]+$/, "");

/* A tag is a word after #, starting with a letter: #gifts, #2026-plans is
 * not one but #plans-2026 is. Any script counts — with its marks, the vowel
 * signs of Malayalam or Hindi, which are not letters to Unicode. */
export const TAG_PATTERN = /(^|[\s(])#(\p{L}[\p{L}\p{M}\p{N}_-]{0,39})/gu;
export const IS_TAG = /^\p{L}[\p{L}\p{M}\p{N}_-]{0,39}$/u;

export const normalizeTag = (tag) => tag.toLowerCase().replace(/[-_]+$/, "");

/* The tags in a note's text, lowercase, each once, in the order they first
 * appear. A # inside a link (a page's #section) is not a tag. */
export function tagsOf(text) {
  const tags = new Set();
  for (const m of String(text).replace(URL_PATTERN, " ").matchAll(TAG_PATTERN)) {
    const tag = normalizeTag(m[2]);
    if (tag) tags.add(tag);
  }
  return [...tags];
}

/* What was typed in the search box, as an FTS5 query: every word must be
 * there, each as the start of a word ("dent" finds "dentist"). Words are
 * split where the index splits them — only letters, their marks and digits
 * are kept — so nothing typed can be FTS5 syntax: no quotes, no NEAR, no
 * column filters, nothing that makes the query fail. '' when there is
 * nothing to look for. */
export function searchQuery(typed) {
  const words = String(typed).normalize("NFKC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return words
    .slice(0, 12)
    .map((word) => `"${word}"*`)
    .join(" ");
}
