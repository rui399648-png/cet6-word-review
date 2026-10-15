/* ui.js — 界面层：视图切换、词书加载、复习会话、发音、导出。依赖全局 XLSX / AppLogic / AppStorage */
(function () {
  "use strict";

  var L = window.AppLogic;
  var S = window.AppStorage;

  var state = {
    bookName: null,
    book: null,      // {sheetName, rows, cols, words}
    progress: {},    // {word: {rounds:[bool], updatedAt}}
    session: null,   // {queue,pos,total,counts,reviewed,last,filter}
    savedSessions: Object.create(null),
    savedProgress: Object.create(null),
    flipped: false,
    settings: { autoSpeak: true }
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 3000);
  }

  var VIEWS = ["view-home", "view-scope", "view-card", "view-summary"];
  function showView(id) {
    VIEWS.forEach(function (v) { $(v).classList.toggle("hidden", v !== id); });
  }

  function storageWarning() {
    $("banner-storage").textContent = "⚠ 浏览器无法保存进度（存储不可用或空间不足），关闭网页后可能无法恢复。";
    $("banner-storage").classList.remove("hidden");
  }

  function savedSession() {
    if (!state.book) return null;
    var saved = Object.prototype.hasOwnProperty.call(state.savedSessions, state.bookName)
      ? state.savedSessions[state.bookName] : S.loadSession(state.bookName);
    var session = L.restoreSession(state.book.words, saved);
    if (saved && !session) {
      state.savedSessions[state.bookName] = null;
      if (!S.clearSession(state.bookName)) storageWarning();
    }
    return session;
  }

  function saveReview() {
    var s = state.session;
    var paused = s && s.pos < s.queue.length ? s : null;
    // 写入失败时也在本页保留断点，横幅提示用户不要依赖关闭后恢复。
    state.savedSessions[state.bookName] = paused;
    state.savedProgress[state.bookName] = state.progress;
    var progressSaved = S.saveProgress(state.bookName, state.progress);
    var sessionSaved = paused ? S.saveSession(state.bookName, paused) : S.clearSession(state.bookName);
    if (!progressSaved || !sessionSaved) storageWarning();
    return progressSaved && sessionSaved;
  }

  function progressForBook(name) {
    if (!Object.prototype.hasOwnProperty.call(state.savedProgress, name)) {
      state.savedProgress[name] = S.loadProgress(name);
    }
    return state.savedProgress[name];
  }

  /* ---------- 发音（Web Speech API，无英文语音时隐藏控件） ---------- */
  var voice = null;
  function setSpeakUI(on) {
    $("btn-speak").style.display = on ? "" : "none";
    $("autospeak-wrap").style.display = on ? "" : "none";
  }
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    var vs = window.speechSynthesis.getVoices() || [];
    if (!vs.length) return; // 语音列表未就绪，等 voiceschanged
    voice = null;
    for (var i = 0; i < vs.length; i++) {
      if (/^en([-_]|$)/i.test(vs[i].lang)) { voice = vs[i]; break; }
    }
    setSpeakUI(!!voice);
  }
  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : "en-US";
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 发音失败不影响复习 */ }
  }

  /* ---------- 词书加载 ---------- */
  function seedProgress(book, existing) {
    var p = {};
    book.words.forEach(function (w) {
      var e = existing[w.word];
      p[w.word] = (e && Array.isArray(e.rounds) && e.rounds.length === w.checked.length)
        ? e
        : { rounds: w.checked.slice(), updatedAt: Date.now() };
    });
    return p;
  }

  function selectBook(name) {
    var book = S.loadBook(name);
    if (!book) { toast("词书缓存读取失败，请重新打开文件"); return; }
    state.bookName = name;
    state.book = book;
    state.progress = progressForBook(name);
    state.settings.lastBook = name;
    if (!S.set(S.KEY.settings, state.settings)) storageWarning();
    renderHome();
  }

  function handleFile(f) {
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { toast("请选择 .xlsx 格式的生词本"); return; }
    var reader = new FileReader();
    reader.onerror = function () { toast("文件读取失败"); };
    reader.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(reader.result), { type: "array" });
        var sheetName = wb.SheetNames[0];
        var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
        var parsed = L.parseRows(rows);
        var book = { sheetName: sheetName, rows: rows, cols: parsed.cols, words: parsed.words };
        if (!S.saveBook(f.name, book)) storageWarning();
        state.bookName = f.name;
        state.book = book;
        state.progress = seedProgress(book, progressForBook(f.name));
        state.savedProgress[f.name] = state.progress;
        if (!S.saveProgress(f.name, state.progress)) storageWarning();
        state.settings.lastBook = f.name;
        if (!S.set(S.KEY.settings, state.settings)) storageWarning();
        renderHome();
        toast("已加载 " + book.words.length + " 词");
        parsed.warnings.forEach(toast);
      } catch (e) {
        if (e && e.missing) toast("表格缺少必需列：" + e.missing.join("、"));
        else toast("无法读取该文件，请选择 .xlsx 生词本");
      }
    };
    reader.readAsArrayBuffer(f);
  }

  /* ---------- 首页 ---------- */
  function masteryBar(st) {
    var wrap = el("div", "bar");
    L.MASTERY.forEach(function (m, i) {
      var pct = st.total ? Math.round(st[m] / st.total * 100) : 0;
      var seg = el("div", "bar-seg seg-" + i, pct >= 10 ? m + " " + st[m] : (pct > 0 ? String(st[m]) : ""));
      seg.style.width = pct + "%";
      seg.title = m + "：" + st[m] + " 词（" + pct + "%）";
      wrap.appendChild(seg);
    });
    return wrap;
  }

  function renderHome() {
    var list = $("home-books");
    list.textContent = "";
    var books = S.listBooks();
    if (!books.length) {
      list.appendChild(el("div", "muted", "还没有词书。点击下方「打开生词本」选择你的 xlsx 文件。"));
    }
    books.forEach(function (b) {
      var card = el("div", "book-card" + (b.name === state.bookName ? " active" : ""));
      var info = el("div", "book-info");
      info.appendChild(el("div", "book-name", b.name));
      info.appendChild(el("div", "muted", b.count + " 词 · 加载于 " + new Date(b.loadedAt).toLocaleString()));
      card.appendChild(info);
      var removeButton = el("button", "danger book-delete", "删除词书");
      removeButton.type = "button";
      removeButton.title = "删除《" + b.name + "》";
      removeButton.addEventListener("click", function (e) {
        e.stopPropagation();
        deleteBook(b.name);
      });
      card.appendChild(removeButton);
      card.addEventListener("click", function () { selectBook(b.name); });
      list.appendChild(card);
    });

    var detail = $("home-detail");
    if (!state.book) { detail.classList.add("hidden"); return; }
    detail.classList.remove("hidden");

    var paused = savedSession();
    $("btn-start").textContent = paused ? "▶ 继续复习" : "▶ 开始复习";
    $("btn-new-session").classList.toggle("hidden", !paused);
    $("resume-info").classList.toggle("hidden", !paused);
    $("resume-info").textContent = paused
      ? "上次停在「" + paused.queue[paused.pos].word + "」 · 已复习 " + paused.reviewed +
        " 词次 · 还剩 " + (paused.queue.length - paused.pos) + " 张（含重练）"
      : "";

    var st = L.stats(state.book.words, state.progress);
    var bars = $("stat-bars");
    bars.textContent = "";
    bars.appendChild(el("div", "stat-title", "《" + state.bookName + "》掌握情况（共 " + st.total + " 词）"));
    bars.appendChild(masteryBar(st));

    var src = $("stat-source");
    src.textContent = "";
    Object.keys(st.bySource).forEach(function (k) {
      var r = el("div", "src-row");
      r.appendChild(el("span", "src-name", k));
      var parts = L.MASTERY.map(function (m) { return m + st.bySource[k][m]; }).join(" / ");
      r.appendChild(el("span", "muted", st.bySource[k].total + " 词 · " + parts));
      src.appendChild(r);
    });
  }

  /* ---------- 选范围 ---------- */
  function checkbox(label, cls) {
    var l = el("label", "chk");
    var c = el("input");
    c.type = "checkbox"; c.className = cls; c.value = label;
    c.addEventListener("change", updateScopeCount);
    l.appendChild(c);
    l.appendChild(document.createTextNode(" " + label));
    return l;
  }
  function checkedValues(cls) {
    return Array.prototype.slice.call(document.querySelectorAll("." + cls + ":checked"))
      .map(function (c) { return c.value; });
  }
  function currentFilter() {
    return {
      sources: checkedValues("scope-src"),
      masteries: checkedValues("scope-mas"),
      includeMastered: $("scope-mastered").checked
    };
  }
  function updateScopeCount() {
    if (!state.book) return;
    var n = L.buildQueue(state.book.words, state.progress, currentFilter()).length;
    $("scope-count").textContent = "本次将复习 " + n + " 词";
  }
  function openScope() {
    if (!state.book) { toast("请先打开生词本"); return; }
    var srcWrap = $("scope-sources");
    srcWrap.textContent = "";
    srcWrap.appendChild(el("div", "stat-title", "来源部分（不勾选 = 全部）"));
    var sources = [];
    state.book.words.forEach(function (w) {
      var s = w.source || "未分类";
      if (sources.indexOf(s) === -1) sources.push(s);
    });
    sources.forEach(function (s) { srcWrap.appendChild(checkbox(s, "scope-src")); });

    var mWrap = $("scope-masteries");
    mWrap.textContent = "";
    mWrap.appendChild(el("div", "stat-title", "掌握程度（不勾选 = 全部，已掌握用下方开关）"));
    L.MASTERY.slice(0, 3).forEach(function (m) { mWrap.appendChild(checkbox(m, "scope-mas")); });

    $("scope-mastered").checked = false;
    updateScopeCount();
    showView("view-scope");
  }

  /* ---------- 复习会话 ---------- */
  function continueOrStart() {
    if (!state.book) { toast("请先打开生词本"); return; }
    var paused = savedSession();
    if (!paused) { openScope(); return; }
    state.session = paused;
    showView("view-card");
    renderCard();
  }

  function startSession() {
    var filter = currentFilter();
    var queue = L.buildQueue(state.book.words, state.progress, filter);
    if (!queue.length) { toast("该范围内没有需要复习的词"); return; }
    state.session = {
      queue: queue, pos: 0, total: queue.length,
      counts: { know: 0, vague: 0, unknown: 0 },
      reviewed: 0, last: null, filter: filter
    };
    saveReview();
    showView("view-card");
    renderCard();
  }

  function currentWord() { return state.session ? state.session.queue[state.session.pos] : null; }

  function renderCard() {
    var s = state.session;
    state.flipped = false;
    var w = currentWord();
    $("card-progress").textContent = "第 " + (s.pos + 1) + " / " + s.queue.length + " 张 · 本次已复习 " + s.reviewed;
    $("card-word").textContent = w.word;
    $("card-pos").textContent = w.pos || "";
    $("card-word2").textContent = w.word + (w.pos ? "  " + w.pos : "");
    $("card-meaning").textContent = w.meaning;
    $("card-source").textContent = w.source ? "来源：" + w.source : "";
    var rounds = L.roundsFor(w, state.progress);
    var dots = $("card-rounds");
    dots.textContent = "";
    rounds.forEach(function (on) {
      dots.appendChild(el("span", "dot" + (on ? " on" : ""), on ? "☑" : "□"));
    });
    $("card-front").classList.remove("hidden");
    $("card-back").classList.add("hidden");
    if (state.settings.autoSpeak) speak(w.word);
  }

  function flip() {
    if (!state.session || state.flipped) return;
    state.flipped = true;
    $("card-front").classList.add("hidden");
    $("card-back").classList.remove("hidden");
  }

  var RATING_NAMES = { know: "✅ 认识", vague: "😕 模糊", unknown: "❌ 不认识" };

  function rate(rating) {
    var s = state.session;
    if (!s || !state.flipped) return; // 未翻面不允许评分
    var w = currentWord();
    var res = L.applyRating(L.roundsFor(w, state.progress), rating);
    state.progress[w.word] = { rounds: res.rounds, updatedAt: Date.now() };
    s.counts[rating]++;
    s.reviewed++;
    s.last = { word: w, rating: rating, mastery: res.mastery };
    if (res.requeue) s.queue.push(w);
    s.pos++;
    if (s.pos >= s.queue.length) { endSession(); return; }
    saveReview();
    renderCard();
  }

  function endSession() {
    var s = state.session;
    if (!s) return;
    var paused = s.pos < s.queue.length;
    var saved = saveReview();
    $("summary-title").textContent = paused ? "复习已暂停" : "本轮复习完成 🎉";
    $("btn-again").textContent = paused ? "继续复习" : "再复习一轮";
    var body = $("summary-body");
    body.textContent = "";
    body.appendChild(el("p", "", "共复习 " + s.reviewed + " 词次（含重复出现）。"));
    body.appendChild(el("p", "", "✅ 认识 " + s.counts.know + " 次　😕 模糊 " + s.counts.vague + " 次　❌ 不认识 " + s.counts.unknown + " 次"));
    var st = L.stats(state.book.words, state.progress);
    body.appendChild(el("p", "muted", "当前总进度 — 陌生 " + st["陌生"] + " · 模糊 " + st["模糊"] + " · 熟悉 " + st["熟悉"] + " · 掌握 " + st["掌握"]));
    if (paused) {
      body.appendChild(el("p", "", (saved ? "进度已自动保存" : "进度暂存在当前页面，关闭后可能丢失") +
        "，下次从「" + s.queue[s.pos].word + "」继续。"));
    }
    state.session = null;
    showView("view-summary");
  }

  function showLast() {
    var s = state.session;
    if (!s || !s.last) { toast("还没有上一张"); return; }
    var b = $("last-body");
    b.textContent = "";
    b.appendChild(el("div", "big", s.last.word.word + "  " + (s.last.word.pos || "")));
    b.appendChild(el("div", "", s.last.word.meaning));
    b.appendChild(el("div", "muted", "你刚才的评分：" + RATING_NAMES[s.last.rating] + " · 当前掌握程度：" + s.last.mastery));
    $("overlay-last").classList.remove("hidden");
  }

  /* ---------- 导出与清除 ---------- */
  function deleteBook(name) {
    if (!window.confirm("确定从程序中删除《" + name + "》吗？\n该词书的缓存、打卡进度和复习断点将被清除，无法恢复。电脑上的原 Excel 文件不会被删除。")) return;
    if (!S.deleteBook(name)) {
      toast("删除词书失败，浏览器存储可能不可用，请重试。");
      return;
    }
    delete state.savedProgress[name];
    delete state.savedSessions[name];
    if (state.settings.lastBook === name) delete state.settings.lastBook;
    if (state.bookName === name) {
      state.bookName = null;
      state.book = null;
      state.progress = {};
      state.session = null;
      state.flipped = false;
      renderHome();
      var books = S.listBooks();
      if (books.length) selectBook(books[0].name);
    } else {
      renderHome();
    }
    toast("已删除词书《" + name + "》");
  }

  function exportXlsx() {
    if (!state.book) { toast("请先打开生词本"); return; }
    try {
      var aoa = L.buildExportRows(state.book.rows, state.book.cols, state.progress);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = aoa[0].map(function (h, i) { return { wch: i === 0 ? 6 : 14 }; });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, state.book.sheetName || "生词本");
      var d = new Date();
      var ds = "" + d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
      var fname = state.bookName.replace(/\.xlsx$/i, "") + "_打卡_" + ds + ".xlsx";
      XLSX.writeFile(wb, fname);
      toast("已导出 " + fname);
    } catch (e) {
      toast("导出失败：" + ((e && e.message) || e) + "（若浏览器拦截下载，请允许后重试）");
    }
  }

  function clearProgress() {
    if (!state.book) return;
    if (!window.confirm("确定清除《" + state.bookName + "》的全部复习进度吗？此操作不可恢复。")) return;
    var p = {};
    state.book.words.forEach(function (w) {
      p[w.word] = { rounds: w.checked.map(function () { return false; }), updatedAt: Date.now() };
    });
    state.progress = p;
    state.session = null;
    var saved = saveReview();
    renderHome();
    toast(saved ? "进度已清除" : "本页进度已清除，但未能更新浏览器存储");
  }

  /* ---------- 初始化 ---------- */
  function init() {
    if (!S.isAvailable()) storageWarning();

    state.settings = S.get(S.KEY.settings, { autoSpeak: true });
    $("chk-autospeak").checked = !!state.settings.autoSpeak;
    $("chk-autospeak").addEventListener("change", function () {
      state.settings.autoSpeak = this.checked;
      if (!S.set(S.KEY.settings, state.settings)) storageWarning();
    });

    $("btn-open").addEventListener("click", function () { $("file-input").click(); });
    $("file-input").addEventListener("change", function () { handleFile(this.files[0]); this.value = ""; });
    $("btn-start").addEventListener("click", continueOrStart);
    $("btn-new-session").addEventListener("click", openScope);
    $("btn-export").addEventListener("click", exportXlsx);
    $("btn-clear").addEventListener("click", clearProgress);
    $("btn-scope-start").addEventListener("click", startSession);
    $("btn-scope-back").addEventListener("click", function () { renderHome(); showView("view-home"); });

    $("flashcard").addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("button")) return;
      flip();
    });
    $("btn-speak").addEventListener("click", function (e) {
      e.stopPropagation();
      var w = currentWord();
      if (w) speak(w.word);
    });
    $("btn-know").addEventListener("click", function () { rate("know"); });
    $("btn-vague").addEventListener("click", function () { rate("vague"); });
    $("btn-unknown").addEventListener("click", function () { rate("unknown"); });
    $("btn-review-last").addEventListener("click", showLast);
    $("btn-close-last").addEventListener("click", function () { $("overlay-last").classList.add("hidden"); });
    $("btn-end").addEventListener("click", function () {
      if (state.session) endSession(); else { renderHome(); showView("view-home"); }
    });
    $("btn-again").addEventListener("click", continueOrStart);
    $("btn-home").addEventListener("click", function () { renderHome(); showView("view-home"); });

    document.addEventListener("keydown", function (e) {
      if (!$("overlay-last").classList.contains("hidden") && e.key === "Escape") {
        $("overlay-last").classList.add("hidden");
        return;
      }
      if ($("view-card").classList.contains("hidden")) return;
      if (e.code === "Space") { e.preventDefault(); flip(); }
      else if (e.key === "1") rate("know");
      else if (e.key === "2") rate("vague");
      else if (e.key === "3") rate("unknown");
    });

    if ("speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", pickVoice);
    }
    setSpeakUI(false);
    pickVoice();

    renderHome();
    var books = S.listBooks();
    var lastBook = books.filter(function (b) { return b.name === state.settings.lastBook; })[0];
    if (books.length) selectBook(lastBook ? lastBook.name : books[0].name);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
