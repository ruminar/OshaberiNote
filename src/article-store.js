/* 背景処理だけが記事の永続DBを操作する。本文は記事IDごとに一度だけ保存する。 */
(() => {
  "use strict";
  let opening;
  function database() {
    if (!globalThis.indexedDB) return Promise.reject(new Error("記事の永続保存を利用できません。ブラウザの保存設定を確認してください。"));
    return opening ??= new Promise((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open("oshaberiNote.articles.v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("articles", { keyPath: "articleId" });
        request.result.createObjectStore("state");
      };
      request.onerror = () => { opening = undefined; reject(request.error); };
      request.onblocked = () => { blocked = true; opening = undefined; reject(new Error("記事DBの更新が待機中です。古いおしゃべり画面を閉じて再読み込みしてください。")); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
    });
  }
  async function get() {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["state", "articles"], "readonly");
      const state = tx.objectStore("state").get("current"), articles = tx.objectStore("articles").getAll();
      tx.oncomplete = () => resolve(state.result === undefined ? undefined : { ...state.result, articles: articles.result });
      tx.onabort = () => reject(tx.error ?? new Error("記事DBの読み込みが中止されました。"));
      tx.onerror = () => {};
    });
  }
  async function write(value) {
    const db = await database(), record = value === undefined ? undefined : structuredClone(value);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["state", "articles"], "readwrite"), articles = tx.objectStore("articles"), state = tx.objectStore("state");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("記事DBの保存が中止されました。"));
      tx.onerror = () => {};
      if (record === undefined) { articles.clear(); state.clear(); return; }
      const { articles: values, ...metadata } = record;
      const existing = articles.getAll();
      existing.onsuccess = () => {
        try {
          const old = new Map(existing.result.map(item => [item.articleId, item])), ids = new Set(values.map(item => item.articleId));
          for (const id of old.keys()) if (!ids.has(id)) articles.delete(id);
          for (const item of values) if (JSON.stringify(old.get(item.articleId)) !== JSON.stringify(item)) articles.put(item);
          state.put(metadata, "current");
        } catch { tx.abort(); }
      };
    });
  }
  globalThis.OshaberiNoteArticleStore = Object.freeze({ get, set: write, remove: () => write(undefined) });
})();
