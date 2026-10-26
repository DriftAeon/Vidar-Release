import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("words are lowercased and joined with dashes", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});

test("accents are dropped", () => {
  assert.equal(slugify("Crème brûlée"), "creme-brulee");
});

test("long titles are cut on a word boundary", () => {
  const slug = slugify("a very long title ".repeat(10), 20);
  assert.ok(slug.length <= 20);
  assert.ok(!slug.endsWith("-"));
});

test("an empty title gives an empty slug", () => {
  assert.equal(slugify(""), "");
});
