"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const MOD = path.join(__dirname, "..", "src", "storage.js");

function fresh() {
  delete require.cache[require.resolve(MOD)];
  return require(MOD);
}
function makeMock() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}

test("get/set/remove 往返 JSON 值，未命中返回 fallback", () => {
  globalThis.localStorage = makeMock();
  const S = fresh();
  S._resetProbe();
  assert.strictEqual(S.isAvailable(), true);
  assert.strictEqual(S.get("k1", "fb"), "fb");
  S.set("k1", { a: [1, 2] });
  assert.deepStrictEqual(S.get("k1", null), { a: [1, 2] });
  S.remove("k1");
  assert.strictEqual(S.get("k1", "fb"), "fb");
});

test("存储抛异常（隐私模式）时安全降级", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); }
  };
  const S = fresh();
  S._resetProbe();
  assert.strictEqual(S.isAvailable(), false);
  assert.strictEqual(S.get("x", "fb"), "fb");
  assert.strictEqual(S.set("x", 1), false);
  S.remove("x"); // 不抛错即可
  assert.deepStrictEqual(S.listBooks(), []);
  assert.strictEqual(S.loadSession("f.xlsx"), null);
  assert.strictEqual(S.saveSession("f.xlsx", { pos: 0 }), false);
  assert.strictEqual(S.clearSession("f.xlsx"), false);
});

test("词书索引与进度存取，最近加载排前", () => {
  globalThis.localStorage = makeMock();
  const S = fresh();
  S._resetProbe();
  const book = { sheetName: "六级生词本", rows: [], cols: {}, words: [{ word: "a" }, { word: "b" }] };
  S.saveBook("f.xlsx", book);
  S.saveBook("g.xlsx", Object.assign({}, book, { words: [{ word: "c" }] }));
  const list = S.listBooks();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, "g.xlsx");
  assert.strictEqual(list[1].name, "f.xlsx");
  assert.strictEqual(list[1].count, 2);
  assert.ok(list[0].loadedAt > 0);
  assert.strictEqual(S.loadBook("f.xlsx").sheetName, "六级生词本");
  assert.strictEqual(S.loadBook("missing.xlsx"), null);
  S.saveProgress("f.xlsx", { a: { rounds: [true], updatedAt: 1 } });
  assert.deepStrictEqual(S.loadProgress("f.xlsx").a.rounds, [true]);
  S.clearProgress("f.xlsx");
  assert.deepStrictEqual(S.loadProgress("f.xlsx"), {});
});

test("saveBook 同名覆盖不产生重复索引", () => {
  globalThis.localStorage = makeMock();
  const S = fresh();
  S._resetProbe();
  const book = { sheetName: "s", rows: [], cols: {}, words: [{ word: "a" }] };
  S.saveBook("f.xlsx", book);
  S.saveBook("f.xlsx", book);
  assert.strictEqual(S.listBooks().length, 1);
});

test("settings 键可用", () => {
  globalThis.localStorage = makeMock();
  const S = fresh();
  S._resetProbe();
  assert.strictEqual(S.KEY.settings, "cet6rev.settings");
  S.set(S.KEY.settings, { autoSpeak: false });
  assert.deepStrictEqual(S.get(S.KEY.settings, {}), { autoSpeak: false });
});

test("复习断点按词书保存，独立于打卡记录且可单独清除", () => {
  globalThis.localStorage = makeMock();
  const S = fresh();
  const session = { queue: [{ rowIndex: 1, word: "a" }], pos: 0 };
  assert.strictEqual(S.loadSession("f.xlsx"), null);
  assert.strictEqual(S.saveSession("f.xlsx", session), true);
  S.saveSession("g.xlsx", { queue: [{ rowIndex: 2, word: "b" }], pos: 0 });
  S.saveProgress("f.xlsx", { a: { rounds: [true] } });
  assert.deepStrictEqual(S.loadSession("f.xlsx"), session);
  S.clearSession("f.xlsx");
  assert.strictEqual(S.loadSession("f.xlsx"), null);
  assert.strictEqual(S.loadSession("g.xlsx").queue[0].word, "b");
  assert.deepStrictEqual(S.loadProgress("f.xlsx").a.rounds, [true]);
});

test("删除词书只清理指定词书、打卡、断点和最近打开记录", () => {
  globalThis.localStorage = makeMock();
  const S = fresh();
  const book = { sheetName: "词表", words: [{ word: "apple" }] };
  for (const name of ["A.xlsx", "B.xlsx"]) {
    S.saveBook(name, book);
    S.saveProgress(name, { apple: { rounds: [true] } });
    S.saveSession(name, { pos: 0 });
  }
  S.set(S.KEY.settings, { autoSpeak: false, lastBook: "A.xlsx", custom: 1 });
  assert.strictEqual(S.deleteBook("A.xlsx"), true);
  assert.deepStrictEqual(S.listBooks().map((b) => b.name), ["B.xlsx"]);
  for (const key of [S.KEY.book("A.xlsx"), S.KEY.progress("A.xlsx"), S.KEY.session("A.xlsx")]) {
    assert.strictEqual(localStorage.getItem(key), null);
  }
  assert.deepStrictEqual(S.loadBook("B.xlsx"), book);
  assert.deepStrictEqual(S.loadProgress("B.xlsx"), { apple: { rounds: [true] } });
  assert.deepStrictEqual(S.loadSession("B.xlsx"), { pos: 0 });
  assert.deepStrictEqual(S.get(S.KEY.settings), { autoSpeak: false, custom: 1 });
  assert.strictEqual(S.deleteBook("missing.xlsx"), true);
  assert.strictEqual(S.deleteBook("B.xlsx"), true);
  assert.deepStrictEqual(S.listBooks(), []);
});

test("删除失败尽力恢复已清理数据，并且保留其他词书的最近打开记录", () => {
  globalThis.localStorage = makeMock();
  const S = fresh();
  const book = { sheetName: "词表", words: [{ word: "apple" }] };
  S.saveBook("A.xlsx", book);
  S.saveProgress("A.xlsx", { apple: { rounds: [true] } });
  S.saveSession("A.xlsx", { pos: 0 });
  S.set(S.KEY.settings, { autoSpeak: true, lastBook: "B.xlsx" });
  const keys = [S.KEY.books, S.KEY.book("A.xlsx"), S.KEY.progress("A.xlsx"), S.KEY.session("A.xlsx"), S.KEY.settings];
  const before = keys.map((key) => localStorage.getItem(key));
  const remove = localStorage.removeItem;
  localStorage.removeItem = (key) => {
    if (key === S.KEY.progress("A.xlsx")) throw new Error("denied");
    remove(key);
  };
  assert.strictEqual(S.deleteBook("A.xlsx"), false);
  assert.deepStrictEqual(keys.map((key) => localStorage.getItem(key)), before);
  localStorage.removeItem = remove;
  assert.strictEqual(S.deleteBook("A.xlsx"), true);
  assert.strictEqual(S.get(S.KEY.settings).lastBook, "B.xlsx");
});
