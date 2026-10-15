"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const XLSX = require("../vendor/xlsx.full.min.js");
const L = require("../src/logic.js");

const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const FIXTURE = path.join(__dirname, "fixtures", "sample.xlsx");
const OUT_DIR = path.join(__dirname, "out");
const OUT = path.join(OUT_DIR, "export_test.xlsx");

test("合成词表：解析→评分→导出→Node断言→Python校验", () => {
  assert.ok(fs.existsSync(FIXTURE), "missing synthetic fixture");
  const wb = XLSX.read(fs.readFileSync(FIXTURE), { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
  const parsed = L.parseRows(aoa);
  assert.strictEqual(parsed.words.length, 204);
  assert.strictEqual(parsed.cols.rounds.length, 5);

  // 播种进度（等价于应用首次加载文件的行为）
  const prog = {};
  parsed.words.forEach((w) => { prog[w.word] = { rounds: w.checked.slice(), updatedAt: Date.now() }; });

  // 模拟评分：词1 认识×1；词2 认识×5；词3 认识×3 后不认识
  const [w1, w2, w3] = parsed.words;
  prog[w1.word].rounds = L.applyRating(prog[w1.word].rounds, "know").rounds;
  let r2 = prog[w2.word].rounds;
  for (let i = 0; i < 5; i++) r2 = L.applyRating(r2, "know").rounds;
  prog[w2.word].rounds = r2;
  let r3 = prog[w3.word].rounds;
  for (let i = 0; i < 3; i++) r3 = L.applyRating(r3, "know").rounds;
  prog[w3.word].rounds = L.applyRating(r3, "unknown").rounds;

  // 导出
  const outAoa = L.buildExportRows(aoa, parsed.cols, prog);
  const ws = XLSX.utils.aoa_to_sheet(outAoa);
  const wbOut = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbOut, ws, sheetName);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, XLSX.write(wbOut, { type: "buffer", bookType: "xlsx" }));

  // Node 侧回读断言
  const chk = XLSX.utils.sheet_to_json(
    XLSX.read(fs.readFileSync(OUT), { type: "buffer" }).Sheets[sheetName],
    { header: 1, defval: "" });
  assert.strictEqual(chk.length, 205);
  assert.strictEqual(chk[1][5], "☑");  assert.strictEqual(chk[1][10], "模糊"); // activate 1轮
  assert.strictEqual(chk[2][9], "☑");  assert.strictEqual(chk[2][10], "掌握"); // aggravated 5轮
  assert.strictEqual(chk[3][5], "□");  assert.strictEqual(chk[3][10], "陌生"); // ascertain 重置
  assert.strictEqual(chk[4][5], "□");  assert.strictEqual(chk[4][10], "陌生"); // 未评的词保持

  // Python openpyxl 独立校验
  // Python 校验失败时退出码会使该测试失败。
  execFileSync(PY, [path.join(__dirname, "verify_export.py"), OUT, FIXTURE], { stdio: "inherit" });
});
