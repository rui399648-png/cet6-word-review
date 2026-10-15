/* logic.js — 纯函数层：不碰 DOM / localStorage / XLSX。UMD：Node 导出，浏览器挂 window.AppLogic */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AppLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MASTERY = ["陌生", "模糊", "熟悉", "掌握"];
  var CHECK_CHARS = "☑✓√✔";

  function cellText(v) { return v == null ? "" : String(v).trim(); }
  function isChecked(v) {
    var s = cellText(v);
    return s.length > 0 && CHECK_CHARS.indexOf(s.charAt(0)) !== -1;
  }

  /** rounds: bool[]（按轮次顺序）。打卡数→掌握程度：0=陌生 1~2=模糊 3~4=熟悉 全部=掌握 */
  function masteryFromRounds(rounds) {
    var total = rounds.length, n = 0;
    for (var i = 0; i < total; i++) if (rounds[i]) n++;
    if (total > 0 && n >= total) return MASTERY[3];
    if (total >= 3 && n >= Math.ceil(total * 0.6)) return MASTERY[2];
    if (n >= 1) return MASTERY[1];
    return MASTERY[0];
  }

  /** 按表头关键字定位列。缺"单词"或"释义"列时抛错，error.missing 为缺失列名数组 */
  function detectColumns(headerRow) {
    var cols = { seq: -1, word: -1, pos: -1, meaning: -1, source: -1, rounds: [], mastery: -1 };
    for (var i = 0; i < headerRow.length; i++) {
      var h = cellText(headerRow[i]).replace(/\s+/g, "");
      if (!h) continue;
      var m = h.match(/^第(\d+)轮/);
      if (m) { cols.rounds.push({ n: parseInt(m[1], 10), idx: i }); continue; }
      if (cols.seq === -1 && h.indexOf("序号") !== -1) cols.seq = i;
      else if (cols.word === -1 && h.indexOf("单词") !== -1) cols.word = i;
      else if (cols.pos === -1 && h.indexOf("词性") !== -1) cols.pos = i;
      else if (cols.meaning === -1 && (h.indexOf("释义") !== -1 || h.indexOf("意思") !== -1)) cols.meaning = i;
      else if (cols.source === -1 && h.indexOf("来源") !== -1) cols.source = i;
      else if (cols.mastery === -1 && h.indexOf("掌握") !== -1) cols.mastery = i;
    }
    cols.rounds.sort(function (a, b) { return a.n - b.n; });
    var missing = [];
    if (cols.word === -1) missing.push("单词");
    if (cols.meaning === -1) missing.push("中文释义");
    if (missing.length) {
      var e = new Error("MISSING_COLUMNS:" + missing.join(","));
      e.missing = missing;
      throw e;
    }
    return cols;
  }

  /** aoa（含表头行）→ { cols, words: Word[], warnings: string[] } */
  function parseRows(aoa) {
    if (!aoa || !aoa.length) throw new Error("EMPTY_SHEET");
    var cols = detectColumns(aoa[0]);
    var words = [], warnings = [];
    if (!cols.rounds.length) warnings.push("未找到轮次列，打卡功能不可用");
    for (var r = 1; r < aoa.length; r++) {
      var line = aoa[r] || [];
      var w = cellText(line[cols.word]);
      var meaning = cellText(line[cols.meaning]);
      if (!w && !meaning) continue;
      if (!w) { warnings.push("第" + (r + 1) + "行缺少单词，已跳过"); continue; }
      words.push({
        rowIndex: r,
        seq: cols.seq === -1 ? String(r) : (cellText(line[cols.seq]) || String(r)),
        word: w,
        pos: cols.pos === -1 ? "" : cellText(line[cols.pos]),
        meaning: meaning,
        source: cols.source === -1 ? "" : cellText(line[cols.source]),
        checked: cols.rounds.map(function (rc) { return isChecked(line[rc.idx]); })
      });
    }
    if (!words.length) throw new Error("NO_WORDS");
    return { cols: cols, words: words, warnings: warnings };
  }

  /** 评分 → 新轮次/掌握程度/是否重新入队。rating: "know"|"vague"|"unknown" */
  function applyRating(rounds, rating) {
    var r = rounds.slice();
    var requeue = false;
    if (rating === "know") {
      var i = r.indexOf(false);
      if (i !== -1) r[i] = true;
    } else if (rating === "vague") {
      requeue = true;
    } else if (rating === "unknown") {
      requeue = true;
      for (var j = 0; j < r.length; j++) r[j] = false;
    } else {
      throw new Error("BAD_RATING:" + rating);
    }
    return { rounds: r, mastery: masteryFromRounds(r), requeue: requeue };
  }

  /** 有效轮次：进度表优先；无进度或长度不符时回退到文件里的打卡状态 */
  function roundsFor(word, progressMap) {
    var p = progressMap ? progressMap[word.word] : null;
    if (p && Array.isArray(p.rounds) && p.rounds.length === word.checked.length) return p.rounds.slice();
    return word.checked.slice();
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** filter: {sources?:string[], masteries?:string[], includeMastered?:bool}；空数组/缺省=不过滤 */
  function buildQueue(words, progressMap, filter) {
    filter = filter || {};
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var mastery = masteryFromRounds(roundsFor(w, progressMap));
      if (!filter.includeMastered && mastery === MASTERY[3]) continue;
      if (filter.sources && filter.sources.length && filter.sources.indexOf(w.source) === -1) continue;
      if (filter.masteries && filter.masteries.length && filter.masteries.indexOf(mastery) === -1) continue;
      out.push(w);
    }
    return shuffle(out);
  }

  /** 恢复未完成的会话，队列按行号+单词映射到当前词表；无效断点返回 null。 */
  function restoreSession(words, saved) {
    if (!saved || !Array.isArray(saved.queue) || !saved.queue.length ||
        !Number.isInteger(saved.pos) || saved.pos < 0 || saved.pos >= saved.queue.length ||
        !Number.isInteger(saved.total) || saved.total < 1 || saved.total > saved.queue.length ||
        saved.reviewed !== saved.pos) return null;
    var c = saved.counts, f = saved.filter;
    if (!c || ![c.know, c.vague, c.unknown].every(function (n) {
      return Number.isInteger(n) && n >= 0;
    }) || c.know + c.vague + c.unknown !== saved.reviewed) return null;
    if (!f || !Array.isArray(f.sources) || !Array.isArray(f.masteries) ||
        !f.sources.concat(f.masteries).every(function (v) { return typeof v === "string"; }) ||
        typeof f.includeMastered !== "boolean") return null;

    var byRow = Object.create(null), queue = [];
    words.forEach(function (w) { byRow[w.rowIndex] = w; });
    for (var i = 0; i < saved.queue.length; i++) {
      var ref = saved.queue[i];
      var w = ref && byRow[ref.rowIndex];
      if (!w || w.rowIndex !== ref.rowIndex || w.word !== ref.word) return null;
      queue.push(w);
    }
    var last = null;
    if (saved.pos > 0) {
      var previous = queue[saved.pos - 1];
      if (!saved.last || !saved.last.word ||
          saved.last.word.rowIndex !== previous.rowIndex || saved.last.word.word !== previous.word ||
          ["know", "vague", "unknown"].indexOf(saved.last.rating) === -1 ||
          MASTERY.indexOf(saved.last.mastery) === -1) return null;
      last = { word: queue[saved.pos - 1], rating: saved.last.rating, mastery: saved.last.mastery };
    }
    return {
      queue: queue, pos: saved.pos, total: saved.total,
      counts: { know: c.know, vague: c.vague, unknown: c.unknown },
      reviewed: saved.reviewed, last: last,
      filter: { sources: f.sources.slice(), masteries: f.masteries.slice(), includeMastered: f.includeMastered }
    };
  }

  /** 首页统计：四档计数 + 按来源分组 */
  function stats(words, progressMap) {
    var s = { total: words.length, bySource: {} };
    for (var k = 0; k < MASTERY.length; k++) s[MASTERY[k]] = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var m = masteryFromRounds(roundsFor(w, progressMap));
      s[m]++;
      var src = w.source || "未分类";
      if (!s.bySource[src]) {
        s.bySource[src] = { total: 0 };
        for (var k2 = 0; k2 < MASTERY.length; k2++) s.bySource[src][MASTERY[k2]] = 0;
      }
      s.bySource[src].total++;
      s.bySource[src][m]++;
    }
    return s;
  }

  /** 导出矩阵：复制原 aoa，仅覆写轮次列(☑/□)与掌握程度列。
   *  progressMap 有条目且 rounds 长度与轮次列数一致时用进度，否则用该行文件内打卡。 */
  function buildExportRows(aoa, cols, progressMap) {
    var out = [];
    for (var r = 0; r < aoa.length; r++) out.push((aoa[r] || []).slice());
    var nRounds = cols.rounds.length;
    for (var i = 1; i < out.length; i++) {
      var line = out[i];
      var w = cellText(line[cols.word]);
      if (!w) continue;
      var p = progressMap ? progressMap[w] : null;
      var rounds = (p && Array.isArray(p.rounds) && p.rounds.length === nRounds)
        ? p.rounds
        : cols.rounds.map(function (rc) { return isChecked(line[rc.idx]); });
      for (var j = 0; j < nRounds; j++) {
        line[cols.rounds[j].idx] = rounds[j] ? "☑" : "□";
      }
      if (cols.mastery !== -1) line[cols.mastery] = masteryFromRounds(rounds);
    }
    return out;
  }

  return {
    MASTERY: MASTERY,
    masteryFromRounds: masteryFromRounds,
    detectColumns: detectColumns,
    parseRows: parseRows,
    applyRating: applyRating,
    roundsFor: roundsFor,
    buildQueue: buildQueue,
    restoreSession: restoreSession,
    stats: stats,
    buildExportRows: buildExportRows
  };
});
