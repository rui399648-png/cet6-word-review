"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/logic.js");

const words = L.parseRows([
  ["单词", "中文释义", "第1轮", "第2轮"],
  ["apple", "苹果", "□", "□"],
  ["pear", "梨", "□", "□"],
  ["apple", "另一行的苹果", "□", "□"]
]).words;

function snapshot() {
  return JSON.parse(JSON.stringify({
    queue: [words[2], words[0], words[1], words[2]],
    pos: 1, total: 3, counts: { know: 0, vague: 1, unknown: 0 }, reviewed: 1,
    last: { word: words[2], rating: "vague", mastery: "陌生" },
    filter: { sources: [], masteries: ["陌生"], includeMastered: false }
  }));
}

test("恢复完整队列顺序、重复词条、未评分位置与评分统计", () => {
  const saved = snapshot();
  const restored = L.restoreSession(words, saved);
  assert.equal(restored.pos, 1);
  assert.equal(restored.queue[restored.pos], words[0]);
  assert.deepEqual(restored.queue, [words[2], words[0], words[1], words[2]]);
  assert.equal(restored.queue[0], words[2]);
  assert.equal(restored.queue[3], words[2]);
  assert.equal(restored.reviewed, 1);
  assert.deepEqual(restored.counts, { know: 0, vague: 1, unknown: 0 });
  assert.equal(restored.last.word, words[2]);
  assert.deepEqual(restored.filter, saved.filter);
  assert.deepEqual(saved, snapshot());
});

test("恢复时使用当前词条的最新释义，行号相同但单词改变则放弃断点", () => {
  const current = words.map((w) => ({ ...w, meaning: "更新后的释义" }));
  assert.equal(L.restoreSession(current, snapshot()).queue[1].meaning, "更新后的释义");
  current[1].word = "banana";
  assert.equal(L.restoreSession(current, snapshot()), null);
});

test("损坏、越界、已完成及统计不一致的断点安全忽略", () => {
  const invalid = [null, {}, [], { ...snapshot(), queue: [] },
    { ...snapshot(), pos: -1 }, { ...snapshot(), pos: 4 }, { ...snapshot(), pos: 0.5 },
    { ...snapshot(), reviewed: 2 }, { ...snapshot(), counts: { know: -1, vague: 2, unknown: 0 } },
    { ...snapshot(), queue: [null] }, { ...snapshot(), filter: null },
    { ...snapshot(), total: 0 }, { ...snapshot(), total: 5 },
    { ...snapshot(), last: { ...snapshot().last, word: { rowIndex: 99, word: "missing" } } }];
  invalid.forEach((saved) => assert.equal(L.restoreSession(words, saved), null));
});
