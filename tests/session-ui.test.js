"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = (name) => fs.readFileSync(path.join(__dirname, "../src", name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

// Only browser boundaries are simulated; all queue, rating and storage code is real.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.classes = new Set();
    this.checked = false;
    this.value = "";
    this.classList = {
      add: (...names) => names.forEach((n) => this.classes.add(n)),
      remove: (...names) => names.forEach((n) => this.classes.delete(n)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : force;
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      }
    };
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(" "); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((c) => c.textContent).join(""); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  dispatch(name, detail = {}) {
    const event = { target: this, stopPropagation() { this.cancelBubble = true; }, preventDefault() {}, ...detail };
    for (const handler of this.listeners[name] || []) handler.call(this, event);
    if (name === "click" && !event.cancelBubble && this.parentElement) this.parentElement.dispatch(name, event);
  }
  click() { this.dispatch("click"); }
  closest(tag) {
    return this.tagName.toLowerCase() === tag ? this : this.parentElement?.closest(tag) || null;
  }
}

function storage() {
  const data = new Map();
  return {
    failWrites: false,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { if (this.failWrites) throw new Error("quota exceeded"); data.set(key, String(value)); },
    removeItem(key) { if (this.failWrites) throw new Error("storage unavailable"); data.delete(key); }
  };
}

function browser(localStorage = storage(), seed = true) {
  const ids = {};
  for (const match of src("index.template.html").matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)) {
    const node = ids[match[3]] = new Element(match[1]);
    node.className = match[2].match(/\bclass="([^"]*)"/)?.[1] || "";
    node.textContent = match[4];
  }
  const doc = new Element("document");
  doc.getElementById = (id) => ids[id] || null;
  doc.createElement = (tag) => new Element(tag);
  doc.createTextNode = (text) => Object.assign(new Element("text"), { textContent: text });
  doc.querySelectorAll = (selector) => {
    const [cls] = selector.slice(1).split(":");
    const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
    return Object.values(ids).flatMap((node) => [node, ...descendants(node)])
      .filter((node) => node.classes.has(cls) && (!selector.endsWith(":checked") || node.checked));
  };
  const global = new Element("window");
  const confirmations = [];
  Object.assign(global, { document: doc, localStorage, console, confirmResult: true,
    confirm: (message) => { confirmations.push(message); return global.confirmResult; },
    setTimeout: () => 1, clearTimeout() {}, Uint8Array });
  global.window = global;
  global.self = global;
  const context = vm.createContext(global);
  vm.runInContext("Math.random = () => 0.999999;", context);
  for (const file of ["logic.js", "storage.js"]) vm.runInContext(src(file), context, { filename: file });
  const S = global.AppStorage;
  if (seed) {
    function addBook(name, words) {
      const rows = [["单词", "中文释义", "来源", "第1轮", "第2轮"],
        ...words.map((word) => [word, word + "的释义", "Unit 1", "□", "□"])];
      const { cols, words: parsed } = global.AppLogic.parseRows(rows);
      assert.equal(S.saveBook(name, { sheetName: "词表", rows, cols, words: parsed }), true);
    }
    addBook("B.xlsx", ["lemon", "lime"]);
    addBook("A.xlsx", ["apple", "pear", "plum"]);
  }
  vm.runInContext(src("ui.js"), context, { filename: "ui.js" });
  doc.dispatch("DOMContentLoaded");
  return {
    S, localStorage, ids, confirmations,
    confirm(value) { global.confirmResult = value; },
    click(id) { assert.ok(ids[id], `missing UI element: ${id}`); ids[id].click(); },
    text(id) { return ids[id].textContent; },
    visible(id) { return !ids[id].classList.contains("hidden"); },
    session(name = "A.xlsx") { return plain(S.loadSession(name)); },
    book(name) {
      const card = ids["home-books"].children.find((child) => child.textContent.includes(name));
      assert.ok(card, `missing book: ${name}`); card.click();
    },
    deleteBook(name) {
      const card = ids["home-books"].children.find((child) => child.textContent.includes(name));
      assert.ok(card, `missing book: ${name}`);
      const button = card.children.find((child) => child.tagName === "BUTTON" && child.textContent === "删除词书");
      assert.ok(button, `missing delete button: ${name}`);
      button.click();
    },
    rate(rating) { this.click("flashcard"); this.click("btn-" + rating); }
  };
}

function start(app) {
  app.click("btn-start");
  assert.equal(app.visible("view-scope"), true);
  app.click("btn-scope-start");
  assert.equal(app.visible("view-card"), true);
  assert.equal(app.text("card-word"), "apple");
}

test("暂停后再次继续：保留当前未评分词、重入队顺序、统计与上一张", () => {
  const app = browser();
  start(app);
  assert.ok(app.session(), "开始复习后应自动保存断点");
  app.rate("unknown");
  app.rate("vague");
  const saved = app.session();
  assert.deepEqual(saved.queue.map((word) => word.word), ["apple", "pear", "plum", "apple", "pear"]);
  assert.equal(saved.pos, 2);
  assert.equal(saved.total, 3);
  assert.deepEqual(saved.counts, { know: 0, vague: 1, unknown: 1 });
  assert.equal(saved.reviewed, 2);
  assert.equal(saved.last.word.word, "pear");
  app.click("btn-end");
  assert.equal(app.visible("view-summary"), true);
  assert.deepEqual(app.session(), saved);
  app.click("btn-again");
  assert.equal(app.visible("view-card"), true);
  assert.equal(app.text("card-word"), "plum");
  assert.match(app.text("card-progress"), /已复习 2/);
  app.click("btn-review-last");
  assert.match(app.text("last-body"), /pear/);
  assert.match(app.text("last-body"), /模糊/);
  app.click("btn-close-last");
  for (const word of ["plum", "apple", "pear"]) {
    assert.equal(app.text("card-word"), word);
    app.rate("know");
  }
  assert.equal(app.visible("view-summary"), true);
  assert.equal(app.session(), null, "完整复习后应删除断点");
  assert.match(app.text("summary-body"), /认识 3 次/);
  app.click("btn-again");
  assert.equal(app.visible("view-scope"), true);
});

test("刷新后首页直接续学，并且每次评分后自动保存新的未评分位置", () => {
  let app = browser();
  start(app);
  app.rate("know");
  const saved = app.session();
  assert.ok(saved, "评分后应自动保存会话");
  assert.equal(saved.pos, 1);
  app = browser(app.localStorage, false);
  assert.match(app.text("btn-start"), /继续复习/);
  app.click("btn-start");
  assert.equal(app.visible("view-card"), true);
  assert.equal(app.text("card-word"), "pear");
  assert.equal(app.visible("card-front"), true);
  assert.deepEqual(app.session(), saved);
  app.click("btn-review-last");
  assert.match(app.text("last-body"), /apple/);
  app.click("btn-close-last");
  app.rate("know");
  assert.equal(app.session().pos, 2);
});

test("还未评分就结束并刷新时，仍从第一张恢复且没有上一张", () => {
  let app = browser();
  start(app);
  app.click("btn-end");
  const saved = app.session();
  assert.equal(saved.pos, 0);
  assert.equal(saved.reviewed, 0);
  assert.equal(saved.last, null);
  app = browser(app.localStorage, false);
  assert.match(app.text("btn-start"), /继续复习/);
  app.click("btn-start");
  assert.equal(app.visible("view-card"), true);
  assert.equal(app.text("card-word"), "apple");
  assert.deepEqual(app.session(), saved);
  app.click("btn-review-last");
  assert.match(app.text("toast"), /还没有上一张/);
  assert.equal(app.visible("overlay-last"), false);
});

test("刷新后记住最近选中的词书，并继续该词书的未评分词", () => {
  let app = browser();
  app.book("B.xlsx");
  app.click("btn-start");
  app.click("btn-scope-start");
  app.rate("know");
  app.click("btn-end");
  const saved = app.session("B.xlsx");
  app = browser(app.localStorage, false);
  assert.match(app.text("stat-bars"), /B\.xlsx/);
  assert.match(app.text("btn-start"), /继续复习/);
  app.click("btn-start");
  assert.equal(app.visible("view-card"), true);
  assert.equal(app.text("card-word"), "lime");
  assert.deepEqual(app.session("B.xlsx"), saved);
  assert.equal(app.session("A.xlsx"), null);
});

test("多词书断点相互独立，清除当前词书进度同时删除其断点", () => {
  const app = browser();
  start(app);
  app.rate("know");
  const first = app.session();
  assert.ok(first);
  app.click("btn-end");
  app.click("btn-home");
  app.book("B.xlsx");
  assert.doesNotMatch(app.text("btn-start"), /继续复习/);
  app.click("btn-start");
  app.click("btn-scope-start");
  assert.equal(app.text("card-word"), "lemon");
  app.rate("vague");
  const second = app.session("B.xlsx");
  assert.ok(second);
  app.click("btn-end");
  app.click("btn-home");
  app.book("A.xlsx");
  app.click("btn-start");
  assert.equal(app.text("card-word"), "pear");
  assert.deepEqual(app.session(), first);
  app.click("btn-end");
  app.click("btn-home");
  app.click("btn-clear");
  assert.equal(app.session(), null);
  assert.deepEqual(app.session("B.xlsx"), second);
  assert.ok(Object.values(plain(app.S.loadProgress("A.xlsx"))).every((entry) => entry.rounds.every((on) => !on)));
  assert.doesNotMatch(app.text("btn-start"), /继续复习/);
  app.click("btn-start");
  assert.equal(app.visible("view-scope"), true);
});

test("重新选范围后返回或选空范围不会覆盖原断点", () => {
  const app = browser();
  start(app);
  app.rate("know");
  const saved = app.session();
  assert.ok(saved);
  app.click("btn-end");
  app.click("btn-home");
  app.click("btn-new-session");
  assert.equal(app.visible("view-scope"), true);
  app.click("btn-scope-back");
  assert.deepEqual(app.session(), saved);
  app.click("btn-new-session");
  const inputs = app.ids["scope-masteries"].children.flatMap((node) => node.children)
    .filter((node) => node.tagName === "INPUT");
  const familiar = inputs.find((node) => node.value === "熟悉");
  assert.ok(familiar);
  familiar.checked = true;
  familiar.dispatch("change");
  app.click("btn-scope-start");
  assert.equal(app.visible("view-scope"), true);
  assert.deepEqual(app.session(), saved);
  app.click("btn-scope-back");
  app.click("btn-start");
  assert.equal(app.visible("view-card"), true);
  assert.equal(app.text("card-word"), "pear");
});

test("运行中存储失败时显示持续提示，结束复习不谎称已保存", () => {
  const app = browser();
  start(app);
  assert.equal(app.visible("banner-storage"), false);
  app.localStorage.failWrites = true;
  app.rate("know");
  assert.equal(app.visible("banner-storage"), true);
  app.click("btn-end");
  assert.equal(app.visible("banner-storage"), true);
  assert.doesNotMatch(app.text("summary-body") + app.text("toast"), /已(?:自动)?保存/);
  app.click("btn-home");
  assert.equal(app.visible("banner-storage"), true);
});

test("存储失败后在本页切换词书，保留最新评分与断点并能继续后续词", () => {
  const app = browser();
  start(app);
  app.localStorage.failWrites = true;
  app.rate("know");
  app.click("btn-end");
  app.click("btn-home");
  assert.match(app.text("stat-bars"), /模糊 1/);
  app.book("B.xlsx");
  app.book("A.xlsx");
  assert.match(app.text("stat-bars"), /模糊 1/, "切换回来后仍应保留 apple 的本页评分");
  assert.equal(app.visible("banner-storage"), true);
  app.click("btn-start");
  assert.equal(app.visible("view-card"), true);
  assert.equal(app.text("card-word"), "pear");
  app.rate("know");
  assert.equal(app.text("card-word"), "plum");
  app.click("btn-end");
  app.click("btn-home");
  assert.match(app.text("stat-bars"), /模糊 2/);
  app.book("B.xlsx");
  app.book("A.xlsx");
  assert.match(app.text("stat-bars"), /模糊 2/);
  app.click("btn-start");
  assert.equal(app.text("card-word"), "plum");
  app.rate("know");
  assert.equal(app.visible("view-summary"), true);
  app.click("btn-home");
  assert.match(app.text("stat-bars"), /模糊 3/);
  assert.equal(app.visible("banner-storage"), true);
});

test("取消删除不改变选中词书、打卡和断点，按钮点击不会冒泡选中另一词书", () => {
  const app = browser();
  start(app);
  app.rate("know");
  app.click("btn-end");
  app.click("btn-home");
  const saved = app.session();
  const progress = plain(app.S.loadProgress("A.xlsx"));
  app.confirm(false);
  app.deleteBook("B.xlsx");
  assert.match(app.text("stat-bars"), /A\.xlsx/);
  assert.equal(app.S.listBooks().length, 2);
  assert.deepEqual(app.session(), saved);
  assert.deepEqual(plain(app.S.loadProgress("A.xlsx")), progress);
  assert.match(app.confirmations[0], /B\.xlsx/);
  assert.match(app.confirmations[0], /Excel/);
});

test("删除其他词书不打断当前续学，刷新后已删除词书仍消失", () => {
  let app = browser();
  start(app);
  app.rate("know");
  app.click("btn-end");
  app.click("btn-home");
  const saved = app.session();
  app.deleteBook("B.xlsx");
  assert.deepEqual(plain(app.S.listBooks()).map((b) => b.name), ["A.xlsx"]);
  assert.equal(app.S.loadBook("B.xlsx"), null);
  assert.match(app.text("stat-bars"), /A\.xlsx/);
  assert.deepEqual(app.session(), saved);
  app = browser(app.localStorage, false);
  assert.doesNotMatch(app.text("home-books"), /B\.xlsx/);
  app.click("btn-start");
  assert.equal(app.text("card-word"), "pear");
});

test("删除当前词书切换到剩余词书，同名重新加载后不复用旧内存进度和断点", () => {
  const app = browser();
  const book = app.S.loadBook("A.xlsx");
  start(app);
  app.rate("know");
  app.click("btn-end");
  app.click("btn-home");
  app.deleteBook("A.xlsx");
  assert.match(app.text("stat-bars"), /B\.xlsx/);
  assert.equal(app.S.get(app.S.KEY.settings).lastBook, "B.xlsx");
  assert.equal(app.S.loadBook("A.xlsx"), null);
  assert.deepEqual(plain(app.S.loadProgress("A.xlsx")), {});
  assert.equal(app.session(), null);
  app.S.saveBook("A.xlsx", book);
  app.book("B.xlsx"); // 更新列表，模拟重新加载同名词表。
  app.book("A.xlsx");
  assert.doesNotMatch(app.text("btn-start"), /继续复习/);
  assert.match(app.text("stat-bars"), /陌生 3/);
  start(app);
});

test("删除最后一本词书显示空列表，刷新后不恢复已删除词书", () => {
  let app = browser();
  app.deleteBook("B.xlsx");
  app.deleteBook("A.xlsx");
  assert.equal(app.visible("home-detail"), false);
  assert.match(app.text("home-books"), /还没有词书/);
  assert.equal(app.S.get(app.S.KEY.settings).lastBook, undefined);
  app.click("btn-start");
  assert.equal(app.visible("view-card"), false);
  app = browser(app.localStorage, false);
  assert.equal(app.visible("home-detail"), false);
  assert.match(app.text("home-books"), /还没有词书/);
});

test("删除遇到存储失败时不假报成功，保留当前词书以便重试", () => {
  const app = browser();
  app.localStorage.failWrites = true;
  app.deleteBook("A.xlsx");
  assert.equal(app.S.listBooks().length, 2);
  assert.match(app.text("stat-bars"), /A\.xlsx/);
  assert.match(app.text("toast"), /删除.*失败/);
  assert.doesNotMatch(app.text("toast"), /已删除/);
  app.localStorage.failWrites = false;
  app.deleteBook("A.xlsx");
  assert.match(app.text("stat-bars"), /B\.xlsx/);
});
