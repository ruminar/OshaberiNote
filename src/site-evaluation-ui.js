/* 取得専用タブを使ったサイト評価の試作画面。 */
(() => {
  "use strict";
  const api = globalThis.browser ?? globalThis.chrome;
  const source = globalThis.OshaberiNoteEvaluationSource;
  const byId = id => document.getElementById(`evaluation-${id}`);
  const slots = [...byId("articles").querySelectorAll("input")];
  let target, collector, controller;
  const matches = (value, url) => value?.replace(/\/$/, "") === url;

  function collectorLost() {
    collector = undefined;
    controls();
    return new Error("取得用タブが閉じられたか、別のページに移動しました。「公開プロフィールを取得」からやり直してください。");
  }

  function waitForPage(signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, 400);
      function cancel() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  async function read(url, kind, signal) {
    let previousUrl;
    if (collector) {
      const tab = await api.tabs.get(collector.id).catch(() => null);
      if (!tab || !matches(tab.url, collector.url) || tab.pendingUrl) {
        if (kind === "article") throw collectorLost();
        collector = undefined;
      }
    }
    signal.throwIfAborted();
    if (!collector) {
      if (kind === "article") throw collectorLost();
      const owner = await api.tabs.getCurrent();
      if (!owner) throw new Error("サイト評価をブラウザタブで開いてください。");
      signal.throwIfAborted();
      const tab = await api.tabs.create({ url, windowId: owner.windowId, index: owner.index + 1, active: false });
      collector = { id: tab.id, url };
    } else if (collector.url !== url) {
      previousUrl = collector.url;
      try { await api.tabs.update(collector.id, { url }); }
      catch { throw collectorLost(); }
      collector.url = url;
    }
    const deadline = Date.now() + 12000;
    let reason = "取得用タブの表示を確認できません。";
    let arrived = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const tab = await api.tabs.get(collector.id).catch(() => null);
      if (!tab) throw collectorLost();
      if (matches(tab.url, url)) arrived = true;
      // tabs.updateの直後は、読み込み開始前の旧URLとcompleteが返ることがある。
      const starting = !arrived && previousUrl && matches(tab.url, previousUrl);
      if (tab.status === "complete" && !matches(tab.url, url) && !tab.pendingUrl && !starting) throw collectorLost();
      if (tab.status === "complete" && matches(tab.url, url) && !tab.pendingUrl) {
        const reply = await api.tabs.sendMessage(collector.id, { type: "site-evaluation-read", url, kind }, { frameId: 0 }).catch(() => null);
        signal.throwIfAborted();
        if (reply?.value) return reply.value;
        if (reply?.error) reason = reply.error;
      }
      await waitForPage(signal);
    }
    if (!arrived) collector = undefined;
    throw new Error(reason);
  }

  function controls() {
    const busy = Boolean(controller);
    byId("target").disabled = byId("profile").disabled = busy;
    byId("collect").disabled = busy || !target || !collector;
    byId("candidate").disabled = byId("add").disabled = busy || !target?.candidates.length;
    byId("cancel").disabled = !busy;
    for (const slot of slots) slot.disabled = busy || !target;
  }

  async function run(task) {
    if (controller) return;
    controller = new AbortController(); controls();
    try { await task(controller.signal); }
    catch (error) { byId("status").textContent = controller.signal.aborted ? "取得を中止しました。" : (error.message || "取得に失敗しました。"); }
    finally { controller = undefined; controls(); }
  }

  byId("profile").onclick = () => run(async signal => {
    const url = source.profile(byId("target").value);
    byId("status").textContent = "公開プロフィールを取得中…";
    const next = await read(url, "profile", signal);
    if (target?.authorUrl !== url) {
      for (const slot of slots) slot.value = "";
      byId("results").replaceChildren();
    }
    target = next;
    byId("profile-name").textContent = `${next.name}（${next.authorUrl}）`;
    byId("candidate").replaceChildren();
    for (const candidate of next.candidates) {
      const option = document.createElement("option");
      option.value = candidate.url;
      option.textContent = `${candidate.pinned ? "固定 · " : ""}${candidate.title}`;
      byId("candidate").append(option);
    }
    byId("status").textContent = `初回表示で${next.candidates.length}件の候補を確認しました。`;
  });
  byId("add").onclick = () => {
    const url = byId("candidate").value;
    const empty = slots.find(slot => !slot.value.trim());
    if (empty && url && !slots.some(slot => slot.value === url)) empty.value = url;
  };
  byId("collect").onclick = () => run(async signal => {
    if (source.profile(byId("target").value) !== target.authorUrl) throw new Error("対象を変更する場合は、先に公開プロフィールを取得してください。");
    const selected = new Map();
    for (const slot of slots) {
      if (!slot.value.trim()) continue;
      const item = source.articleFor(slot.value.trim(), target.authorUrl);
      if (selected.has(item.articleId)) throw new Error("同じ記事が複数指定されています。");
      selected.set(item.articleId, item);
    }
    if (!selected.size) throw new Error("取得する記事を指定してください。");
    byId("results").replaceChildren();
    let index = 0, captured = 0;
    for (const { url } of selected.values()) {
      signal.throwIfAborted();
      byId("status").textContent = `記事を取得中（${++index} / ${selected.size}）`;
      const entry = document.createElement("details"), title = document.createElement("summary"), body = document.createElement("pre");
      try {
        const article = await read(url, "article", signal);
        title.textContent = `${article.title}（${article.body.length.toLocaleString()}文字・取得範囲未確認）`;
        body.textContent = article.body; captured++;
      } catch (error) {
        signal.throwIfAborted();
        if (!collector) throw error;
        title.textContent = `取得できませんでした · ${url}`;
        body.textContent = error.message;
      }
      entry.append(title, body); byId("results").append(entry);
    }
    byId("status").textContent = `${selected.size}件のうち${captured}件の本文を取得しました。`;
  });
  byId("cancel").onclick = () => controller?.abort();
  addEventListener("pagehide", () => controller?.abort());
  controls();
})();
