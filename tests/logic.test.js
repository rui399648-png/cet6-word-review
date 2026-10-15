"use strict";
const test = require("node:test");
const assert = require("node:assert");
const L = require("../src/logic.js");

const HEADER = ["序号","单词","词性","中文释义","来源部分",
  "第1轮\n10-12","第2轮\n10-13","第3轮\n10-15","第4轮\n10-18","第5轮\n10-26","掌握程度"];

function row(seq, w, pos, m, src, marks, mastery) {
  return [seq, w, pos, m, src, ...String(marks || "□□□□□").split("")].concat(mastery || "陌生");
}

test("detectColumns 识别真实表头（轮次表头含换行）", () => {
  const c = L.detectColumns(HEADER);
  assert.strictEqual(c.seq, 0);
  assert.strictEqual(c.word, 1);
  assert.strictEqual(c.pos, 2);
  assert.strictEqual(c.meaning, 3);
  assert.strictEqual(c.source, 4);
  assert.deepStrictEqual(c.rounds.map((r) => r.idx), [5, 6, 7, 8, 9]);
  assert.deepStrictEqual(c.rounds.map((r) => r.n), [1, 2, 3, 4, 5]);
  assert.strictEqual(c.mastery, 10);
});

test("detectColumns 缺必需列时抛错并携带 missing", () => {
  assert.throws(
    () => L.detectColumns(["序号", "词性", "来源部分"]),
    (e) => Array.isArray(e.missing) && e.missing.includes("单词") && e.missing.includes("中文释义")
  );
});

test("parseRows 解析单词并识别已有打卡", () => {
  const aoa = [HEADER,
    row(1, "activate", "v.", "激活，启动", "选词填空"),
    row(2, "discourse", "n.", "论文；演说", "仔细阅读B", "□□☑□□")];
  const r = L.parseRows(aoa);
  assert.strictEqual(r.words.length, 2);
  assert.strictEqual(r.words[0].word, "activate");
  assert.strictEqual(r.words[0].rowIndex, 1);
  assert.deepStrictEqual(r.words[0].checked, [false, false, false, false, false]);
  assert.deepStrictEqual(r.words[1].checked, [false, false, true, false, false]);
  assert.deepStrictEqual(r.warnings, []);
});

test("parseRows 跳过空行，缺单词的行跳过并警告", () => {
  const aoa = [HEADER,
    row(1, "a", "n.", "甲", "选词填空"),
    ["", "", "", "", "", "", "", "", "", "", ""],
    row(3, "", "n.", "丙", "选词填空")];
  const r = L.parseRows(aoa);
  assert.strictEqual(r.words.length, 1);
  assert.ok(r.warnings.some((w) => w.includes("第4行")));
});

test("parseRows 无轮次列时警告且 checked 为空数组", () => {
  const r = L.parseRows([["单词", "中文释义"], ["a", "甲"]]);
  assert.strictEqual(r.words.length, 1);
  assert.deepStrictEqual(r.words[0].checked, []);
  assert.ok(r.warnings.some((w) => w.includes("轮次")));
});

test("parseRows 空表抛 EMPTY_SHEET，无词抛 NO_WORDS", () => {
  assert.throws(() => L.parseRows([]), /EMPTY_SHEET/);
  assert.throws(() => L.parseRows([HEADER]), /NO_WORDS/);
});

const WORDS = [
  { rowIndex: 1, seq: "1", word: "a", pos: "v.", meaning: "甲", source: "选词填空", checked: [false,false,false,false,false] },
  { rowIndex: 2, seq: "2", word: "b", pos: "n.", meaning: "乙", source: "听力-短文1", checked: [false,false,false,false,false] },
  { rowIndex: 3, seq: "3", word: "c", pos: "n.", meaning: "丙", source: "选词填空", checked: [false,false,false,false,false] }
];

test("masteryFromRounds 五轮阈值：0陌生/1-2模糊/3-4熟悉/5掌握", () => {
  assert.strictEqual(L.masteryFromRounds([false,false,false,false,false]), "陌生");
  assert.strictEqual(L.masteryFromRounds([true,false,false,false,false]), "模糊");
  assert.strictEqual(L.masteryFromRounds([true,true,false,false,false]), "模糊");
  assert.strictEqual(L.masteryFromRounds([true,true,true,false,false]), "熟悉");
  assert.strictEqual(L.masteryFromRounds([true,true,true,true,false]), "熟悉");
  assert.strictEqual(L.masteryFromRounds([true,true,true,true,true]), "掌握");
  assert.strictEqual(L.masteryFromRounds([]), "陌生");
});

test("applyRating know：打卡第一个未打轮次，不再入队", () => {
  const r = L.applyRating([true,false,false,false,false], "know");
  assert.deepStrictEqual(r.rounds, [true,true,false,false,false]);
  assert.strictEqual(r.mastery, "模糊");
  assert.strictEqual(r.requeue, false);
});

test("applyRating know 且已全打卡：保持不变", () => {
  const r = L.applyRating([true,true,true,true,true], "know");
  assert.deepStrictEqual(r.rounds, [true,true,true,true,true]);
  assert.strictEqual(r.requeue, false);
});

test("applyRating vague：不改轮次，重新入队", () => {
  const r = L.applyRating([true,false,false,false,false], "vague");
  assert.deepStrictEqual(r.rounds, [true,false,false,false,false]);
  assert.strictEqual(r.requeue, true);
});

test("applyRating unknown：清空全部轮次，重新入队", () => {
  const r = L.applyRating([true,true,true,false,false], "unknown");
  assert.deepStrictEqual(r.rounds, [false,false,false,false,false]);
  assert.strictEqual(r.mastery, "陌生");
  assert.strictEqual(r.requeue, true);
});

test("applyRating 非法评分抛错", () => {
  assert.throws(() => L.applyRating([false], "bad"), /BAD_RATING/);
});

test("roundsFor：进度优先，缺进度回退文件打卡，长度不符也回退", () => {
  const prog = { a: { rounds: [true,false,false,false,false], updatedAt: 1 } };
  assert.deepStrictEqual(L.roundsFor(WORDS[0], prog), [true,false,false,false,false]);
  assert.deepStrictEqual(L.roundsFor(WORDS[1], prog), [false,false,false,false,false]);
  const stale = { b: { rounds: [true,true], updatedAt: 1 } }; // 长度2 ≠ 5
  assert.deepStrictEqual(L.roundsFor(WORDS[1], stale), [false,false,false,false,false]);
  const fileMarked = Object.assign({}, WORDS[2], { checked: [true,true,false,false,false] });
  assert.deepStrictEqual(L.roundsFor(fileMarked, {}), [true,true,false,false,false]);
});

test("buildQueue：默认排除已掌握，洗牌不丢词", () => {
  const prog = { c: { rounds: [true,true,true,true,true], updatedAt: 1 } };
  const q = L.buildQueue(WORDS, prog, {});
  assert.deepStrictEqual(q.map((w) => w.word).sort(), ["a", "b"]);
});

test("buildQueue：includeMastered 时包含已掌握", () => {
  const prog = { c: { rounds: [true,true,true,true,true], updatedAt: 1 } };
  assert.strictEqual(L.buildQueue(WORDS, prog, { includeMastered: true }).length, 3);
});

test("buildQueue：按来源过滤", () => {
  const q = L.buildQueue(WORDS, {}, { sources: ["选词填空"] });
  assert.deepStrictEqual(q.map((w) => w.word).sort(), ["a", "c"]);
});

test("buildQueue：按掌握程度过滤（有效掌握度=进度推导）", () => {
  const prog = { b: { rounds: [true,true,true,false,false], updatedAt: 1 } }; // 熟悉
  const q = L.buildQueue(WORDS, prog, { masteries: ["陌生"] });
  assert.deepStrictEqual(q.map((w) => w.word).sort(), ["a", "c"]);
});

test("stats：四档计数与来源分组", () => {
  const prog = {
    a: { rounds: [true,true,true,true,true], updatedAt: 1 },
    b: { rounds: [true,false,false,false,false], updatedAt: 1 }
  };
  const st = L.stats(WORDS, prog);
  assert.strictEqual(st.total, 3);
  assert.strictEqual(st["掌握"], 1);
  assert.strictEqual(st["模糊"], 1);
  assert.strictEqual(st["陌生"], 1);
  assert.strictEqual(st["熟悉"], 0);
  assert.strictEqual(st.bySource["选词填空"].total, 2);
  assert.strictEqual(st.bySource["选词填空"]["掌握"], 1);
  assert.strictEqual(st.bySource["听力-短文1"]["模糊"], 1);
});

test("buildExportRows：写入 ☑/□ 与重算的掌握程度，其他列不动，不改原 aoa", () => {
  const aoa = [HEADER,
    row(1, "activate", "v.", "激活，启动", "选词填空"),
    row(2, "b", "n.", "乙", "听力-短文1")];
  const parsed = L.parseRows(aoa);
  const prog = { activate: { rounds: [true,false,false,false,false], updatedAt: 1 } };
  const out = L.buildExportRows(aoa, parsed.cols, prog);
  assert.deepStrictEqual(out[0], HEADER);              // 表头原样（含 \n）
  assert.strictEqual(out[1][5], "☑");
  assert.strictEqual(out[1][6], "□");
  assert.strictEqual(out[1][10], "模糊");
  assert.strictEqual(out[2][5], "□");
  assert.strictEqual(out[2][10], "陌生");
  assert.strictEqual(out[1][1], "activate");           // 数据列不动
  assert.strictEqual(out[1][3], "激活，启动");
  assert.strictEqual(aoa[1][5], "□");                  // 原数组未被修改
});

test("buildExportRows：无进度条目时按文件已有打卡重算掌握程度", () => {
  const aoa = [HEADER, row(1, "x", "n.", "X", "选词填空", "□□☑□□", "熟悉")];
  const parsed = L.parseRows(aoa);
  const out = L.buildExportRows(aoa, parsed.cols, {});
  assert.strictEqual(out[1][7], "☑");
  assert.strictEqual(out[1][10], "模糊"); // 1 轮打卡 → 模糊（掌握程度总是由打卡重算）
});

test("buildExportRows：进度轮数与列数不符时回退文件打卡", () => {
  const aoa = [HEADER, row(1, "y", "n.", "Y", "选词填空", "☑□□□□")];
  const parsed = L.parseRows(aoa);
  const out = L.buildExportRows(aoa, parsed.cols, { y: { rounds: [true, true], updatedAt: 1 } });
  assert.strictEqual(out[1][5], "☑");
  assert.strictEqual(out[1][6], "□");
  assert.strictEqual(out[1][10], "模糊");
});
