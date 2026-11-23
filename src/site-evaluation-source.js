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

  function publicationDate(elements) {
    const dates = new Set([...elements].map(item => item.getAttribute("datetime")).filter(value =>
      /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value ?? "") && Number.isFinite(Date.parse(value))));
    return dates.size === 1 ? [...dates][0] : null;
  }

  function articleCard(node) {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === "ARTICLE" || parent.classList.contains("grid-rows-subgrid") ||
          (parent.tagName === "DIV" && ["bg-surface-normal", "w-full", "flex-col"].every(name => parent.classList.contains(name)))) return parent;
    }
    return null;
  }

  function cardLikeCounts(card, articleUrl) {
    if (!card || [...card.querySelectorAll("a[href]")].some(link => {
      try { return articles.page(link.href).url !== articleUrl; } catch { return false; }
    })) return [];
    const labels = [];
    for (const icon of card.querySelectorAll('svg[aria-label="スキの数"]')) {
      if (icon.getAttribute("role") !== "img" || icon.getAttribute("data-id") !== "Icon" || articleCard(icon) !== card) continue;
      const group = icon.parentElement;
      if (group?.children.length !== 2 || group.children[0] !== icon || !group.classList.contains("text-text-like")) continue;
      const label = group.children[1];
      if (label.tagName !== "SPAN" || label.children.length) continue;
      labels.push(label.textContent.trim());
    }
    for (const button of card.querySelectorAll("button[aria-label]")) {
      if (articleCard(button) !== card || button.closest("[data-oshaberi-note-owned]")) continue;
      const match = /^(\d+|\d{1,3}(?:,\d{3})+)スキ この記事にスキをつけたユーザーを見る$/.exec(button.getAttribute("aria-label"));
      if (match) labels.push(match[1]);
    }
    const counts = [];
    for (const value of labels) {
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) continue;
      const count = Number(value.replaceAll(",", ""));
      if (Number.isSafeInteger(count)) counts.push(count);
    }
    return counts;
  }

  function readArticle(doc, win, url) {
    const entry = articles.extract(doc, win, url);
    const article = doc.querySelector('article[id="note-article"]');
    const publishedAt = publicationDate([...(article?.querySelectorAll("time[datetime]") ?? [])].filter(node =>
      node.closest("article") === article && !node.closest('[id="note-body"]') && !node.closest('[id="note-paywall"]')));
    return { ...entry, publishedAt };
  }

  function readProfile(doc, win, url) {
    const authorUrl = profile(url);
    const canonicals = [...doc.querySelectorAll('link[rel="canonical"]')];
    if (canonicals.length !== 1 || profile(canonicals[0].href) !== authorUrl) throw new Error("プロフィールのURLと表示内容を確認できません。");
    const visible = node => Boolean(node?.getClientRects().length && win.getComputedStyle(node).visibility === "visible" &&
      !node.closest('[data-oshaberi-note-paid-hidden]') && !node.closest('[data-oshaberi-note-owned], [hidden], [aria-hidden="true"]'));
    const headings = [...doc.querySelectorAll("h1")].filter(visible);
    if (headings.length !== 1 || !headings[0].textContent.trim()) throw new Error("公開プロフィールの表示名を確認できません。");
    const name = core.authorName(headings[0].textContent.trim());
    const main = doc.getElementById("main-content");
    const hasArticleList = [...(main?.querySelectorAll("h2") ?? [])].some(node => visible(node) && node.textContent.trim() === "記事一覧") &&
      !main.querySelector('[data-oshaberi-note-author-hidden]');
    const candidates = new Map(), countsById = new Map(), paidIds = new Set();
    for (const link of main?.querySelectorAll("a[href]") ?? []) {
      if (!visible(link)) continue;
      let address;
      try { address = articleFor(link.href, authorUrl); } catch { continue; }
      const card = articleCard(link);
      const title = (link.getAttribute("title") || link.getAttribute("aria-label") || link.textContent).trim();
      if (!title || title.length > 500) continue;
      if (card && globalThis.OshaberiNoteUi?.hasPaidArticleOffer?.(card)) paidIds.add(address.articleId);
      const pinned = Boolean(card && [...card.querySelectorAll("span, p")].some(node => visible(node) && node.textContent.trim() === "固定された記事"));
      const publishedAt = card ? publicationDate(card.querySelectorAll("time[datetime]")) : null;
      const counts = countsById.get(address.articleId) ?? new Set();
      for (const count of cardLikeCounts(card, address.url)) counts.add(count);
      countsById.set(address.articleId, counts);
      const previous = candidates.get(address.articleId);
      if (!previous || pinned || (!previous.pinned && publishedAt && !previous.publishedAt)) candidates.set(address.articleId, { ...address, title, pinned, publishedAt });
      if (candidates.size === 60) break;
    }
    const entries = [...candidates.values()].map(item => {
      const counts = countsById.get(item.articleId);
      return { ...item, likeCount: counts?.size === 1 ? [...counts][0] : null };
    });
    return { authorUrl, name, candidates: entries.sort((a, b) => Number(b.pinned) - Number(a.pinned)),
      postDates: hasArticleList ? entries.filter(item => !item.pinned && !paidIds.has(item.articleId)).map(item => item.publishedAt) : [] };
  }

  if (api?.runtime?.id && globalThis.location?.origin === "https://note.com" && window === window.top) {
    api.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== "site-evaluation-read" || sender.id !== api.runtime.id || sender.url?.split(/[?#]/)[0] !== api.runtime.getURL("home.html")) return false;
      if (document.readyState !== "complete" || location.href.replace(/\/$/, "") !== message.url) { respond({ waiting: true }); return false; }
      const articleFallback = message.kind === "article" && message.allowArticleWithoutHeader === true;
      if (!articleFallback && !Array.from(document.querySelectorAll("header a[href]")).some(anchor => globalThis.OshaberiNoteUi?.isOfficialHeaderLogo(anchor, message.url))) {
        const page = message.kind === "profile" ? "公開プロフィール" : "記事ページ";
        respond({ waiting: true, headerPending: true, error: `${page}のヘッダーの読み込みを確認できませんでした。` });
        return false;
      }
      try {
        const value = message.kind === "profile" ? readProfile(document, window, message.url) : readArticle(document, window, message.url);
        respond({ value });
      } catch (error) { respond({ error: error.message }); }
      return false;
    });
  }
  globalThis.OshaberiNoteEvaluationSource = Object.freeze({ profile, articleFor, readProfile });
})();
