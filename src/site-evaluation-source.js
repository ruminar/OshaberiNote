/* サイト評価の取得試作。対象と一致するnoteの表示DOMだけを読む。 */
(() => {
  "use strict";
  const core = globalThis.OshaberiNote;
  const articles = globalThis.OshaberiNoteArticles;
  const api = globalThis.browser ?? globalThis.chrome;
  const profile = value => `https://note.com/${core.authorId(value).toLowerCase()}`;

  function articleFor(value, authorUrl) {
    const address = articles.page(value);
    if (address.authorUrl.toLowerCase() !== authorUrl) throw new Error("対象作者の記事URLを指定してください。");
    return address;
  }

  function readProfile(doc, win, url) {
    const authorUrl = profile(url);
    const canonicals = [...doc.querySelectorAll('link[rel="canonical"]')];
    if (canonicals.length !== 1 || profile(canonicals[0].href) !== authorUrl) throw new Error("プロフィールのURLと表示内容を確認できません。");
    const visible = node => Boolean(node?.getClientRects().length && win.getComputedStyle(node).visibility === "visible" && !node.closest('[data-oshaberi-note-owned], [hidden], [aria-hidden="true"]'));
    const headings = [...doc.querySelectorAll("h1")].filter(visible);
    if (headings.length !== 1 || !headings[0].textContent.trim()) throw new Error("公開プロフィールの表示名を確認できません。");
    const name = core.authorName(headings[0].textContent.trim());
    const main = doc.getElementById("main-content");
    const candidates = new Map();
    for (const link of main?.querySelectorAll("a[href]") ?? []) {
      if (!visible(link)) continue;
      let address;
      try { address = articleFor(link.href, authorUrl); } catch { continue; }
      const card = link.closest("article");
      const title = (link.getAttribute("title") || link.getAttribute("aria-label") || link.textContent).trim();
      if (!title || title.length > 500) continue;
      const pinned = Boolean(card && [...card.querySelectorAll("span, p")].some(node => visible(node) && node.textContent.trim() === "固定された記事"));
      if (!candidates.has(address.articleId) || pinned) candidates.set(address.articleId, { ...address, title, pinned });
      if (candidates.size === 60) break;
    }
    return { authorUrl, name, candidates: [...candidates.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned)) };
  }

  if (api?.runtime?.id && globalThis.location?.origin === "https://note.com" && window === window.top) {
    api.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== "site-evaluation-read" || sender.id !== api.runtime.id || sender.url?.split(/[?#]/)[0] !== api.runtime.getURL("home.html")) return false;
      if (document.readyState !== "complete" || location.href.replace(/\/$/, "") !== message.url) { respond({ waiting: true }); return false; }
      try {
        const value = message.kind === "profile" ? readProfile(document, window, message.url) : articles.extract(document, window, message.url);
        respond({ value });
      } catch (error) { respond({ error: error.message }); }
      return false;
    });
  }
  globalThis.OshaberiNoteEvaluationSource = Object.freeze({ profile, articleFor, readProfile });
})();
