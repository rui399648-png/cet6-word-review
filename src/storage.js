/* storage.js — localStorage 封装（UMD）。惰性探测可用性；不可用时全部操作安全降级。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AppStorage = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var KEY = {
    books: "cet6rev.books",
    book: function (n) { return "cet6rev.book." + n; },
    progress: function (n) { return "cet6rev.progress." + n; },
    session: function (n) { return "cet6rev.session." + n; },
    settings: "cet6rev.settings"
  };

  var _avail = null;
  function isAvailable() {
    if (_avail === null) {
      var s = null;
      try { s = (typeof localStorage !== "undefined") ? localStorage : null; } catch (e) { s = null; }
      if (!s) { _avail = false; }
      else {
        try { s.setItem("__cet6_probe", "1"); s.removeItem("__cet6_probe"); _avail = true; }
        catch (e) { _avail = false; }
      }
    }
    return _avail;
  }
  function _resetProbe() { _avail = null; }

  function get(key, fallback) {
    if (!isAvailable()) return fallback;
    try {
      var v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function set(key, value) {
    if (!isAvailable()) return false;
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }
  function remove(key) {
    if (!isAvailable()) return false;
    try { localStorage.removeItem(key); return true; } catch (e) { return false; }
  }

  function listBooks() { return get(KEY.books, []); }
  function saveBook(name, data) {
    var idx = listBooks().filter(function (b) { return b.name !== name; });
    idx.unshift({ name: name, sheetName: data.sheetName, count: data.words.length, loadedAt: Date.now() });
    set(KEY.books, idx);
    return set(KEY.book(name), data);
  }
  function loadBook(name) { return get(KEY.book(name), null); }
  function deleteBook(name) {
    if (!isAvailable()) return false;
    var keys = [KEY.books, KEY.book(name), KEY.progress(name), KEY.session(name), KEY.settings];
    var before;
    try {
      before = keys.map(function (key) { return localStorage.getItem(key); });
      var books = JSON.parse(before[0] || "[]");
      var settings = JSON.parse(before[4] || "{}");
      var remaining = books.filter(function (book) { return book.name !== name; });
      for (var i = 1; i <= 3; i++) localStorage.removeItem(keys[i]);
      localStorage.setItem(KEY.books, JSON.stringify(remaining));
      if (settings.lastBook === name) {
        delete settings.lastBook;
        localStorage.setItem(KEY.settings, JSON.stringify(settings));
      }
      return true;
    } catch (e) {
      // localStorage 不支持事务；异常时尽力恢复已改变的键，以便用户重试。
      if (before) keys.forEach(function (key, i) {
        try {
          if (localStorage.getItem(key) === before[i]) return;
          if (before[i] === null) localStorage.removeItem(key);
          else localStorage.setItem(key, before[i]);
        } catch (restoreError) { /* 存储持续不可用时由界面提示删除失败 */ }
      });
      return false;
    }
  }
  function loadProgress(name) { return get(KEY.progress(name), {}); }
  function saveProgress(name, map) { return set(KEY.progress(name), map); }
  function clearProgress(name) { remove(KEY.progress(name)); }
  function loadSession(name) { return get(KEY.session(name), null); }
  function saveSession(name, session) { return set(KEY.session(name), session); }
  function clearSession(name) { return remove(KEY.session(name)); }

  return {
    KEY: KEY, get: get, set: set, remove: remove,
    isAvailable: isAvailable, _resetProbe: _resetProbe,
    listBooks: listBooks, saveBook: saveBook, loadBook: loadBook, deleteBook: deleteBook,
    loadProgress: loadProgress, saveProgress: saveProgress, clearProgress: clearProgress,
    loadSession: loadSession, saveSession: saveSession, clearSession: clearSession
  };
});
