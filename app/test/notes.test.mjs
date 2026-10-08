import assert from "node:assert/strict";
import { test } from "node:test";
import { searchQuery, tagsOf } from "../src/notes.mjs";
import { noteText } from "../src/views/notes.mjs";

test("a tag is a word after #, starting with a letter, in any script", () => {
  assert.deepEqual(tagsOf("Ideas #Gifts and #gifts again, #health. (#Ünïcode) #ജന്മദിനം"), ["gifts", "health", "ünïcode", "ജന്മദിനം"]);
  assert.deepEqual(tagsOf("#2026 is a year, a#b is not a tag, #plans-2026 is, #trailing- loses its dash"), ["plans-2026", "trailing"]);
  assert.deepEqual(tagsOf("A link's fragment is no tag: https://example.com/page#section"), []);
  assert.deepEqual(tagsOf(""), []);
});

test("what is typed in search becomes words to look for, never FTS5 syntax", () => {
  assert.equal(searchQuery("dent tues"), '"dent"* "tues"*');
  assert.equal(searchQuery('" OR NEAR(title: x*) AND -y ^z'), '"OR"* "NEAR"* "title"* "x"* "AND"* "y"* "z"*');
  assert.equal(searchQuery("  ...  "), "");
  assert.equal(searchQuery("Café"), '"Café"*');
  assert.equal(searchQuery("a b c d e f g h i j k l m n").split(" ").length, 12, "a dozen words at most");
});

test("a note's text: escaped, with its links and tags made links, and WhatsApp's bold", () => {
  assert.equal(
    String(noteText("A *good* pen #gifts — see https://example.com/pens?a=1&b=2.")),
    'A <strong>good</strong> pen <a class="tag" href="/notes?tag=gifts">#gifts</a> — see <a href="https://example.com/pens?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">https://example.com/pens?a=1&amp;b=2</a>.',
  );
  assert.equal(String(noteText("<script>alert(1)</script>")), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(String(noteText("javascript:alert(1) and data:text/html,x")), "javascript:alert(1) and data:text/html,x", "only http(s) is a link");
  assert.equal(String(noteText('https://x.example/"onmouseover="alert(1)')), '<a href="https://x.example/" rel="noopener noreferrer" target="_blank">https://x.example/</a>&quot;onmouseover=&quot;alert(1)');
  assert.equal(String(noteText("Tom's #Plans")), 'Tom&#39;s <a class="tag" href="/notes?tag=plans">#Plans</a>');
});

test("Malayalam and Hindi words are searched whole, vowel signs and all", () => {
  assert.equal(searchQuery("ജന്മദിനം ആശംസകൾ"), '"ജന്മദിനം"* "ആശംസകൾ"*');
  assert.equal(searchQuery("नमस्ते"), '"नमस्ते"*');
});
