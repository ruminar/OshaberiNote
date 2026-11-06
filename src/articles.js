/* 記事の資料・会話・受け渡しはブラウザセッション内だけに置く。 */
(() => {
  "use strict";
  const id = "article", key = "oshaberiNote.articles.session.v1", maxBytes = 8 * 1024 * 1024;
  const actions = Object.freeze({
    summary: { suffix: "について要約して", instruction: "下記の文章を、極力意味を失わないように要約してください\n文章の改善提案等は要りません" },
    impression: { suffix: "について感想を聞かせて", instruction: "下記の記事を読んで、感想を聞かせてください。" },
    revision: { suffix: "について修正点を教えて", instruction: "下記の記事を読んで、修正した方がよい点があれば具体的に指摘してください。" }
  });
  const invalid = message => Object.assign(new Error(message), { code: "INVALID_INPUT" });
  function page(url) {
    let parsed; try { parsed = new URL(url); } catch { throw invalid("記事URLを確認できません。"); }
    const match = /^\/([a-zA-Z0-9_]+)\/n\/(n[a-zA-Z0-9]+)\/?$/.exec(parsed.pathname);
    if (parsed.origin !== "https://note.com" || parsed.username || parsed.password || !match) throw invalid("noteの公開記事ページで実行してください。");
    return { articleId: match[2], authorUrl: `https://note.com/${match[1]}`, url: `https://note.com/${match[1]}/n/${match[2]}` };
  }
  function validate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("記事情報の形式が不正です。");
    const canonical = page(value.url);
    for (const [field, maximum] of [["title", 500], ["author", 200], ["body", 200000]]) {
      if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > maximum) throw invalid("記事のタイトル・著者・本文が空か、取得上限を超えています。空の本文や切り詰めた本文は送信しません。");
    }
    if (value.articleId !== canonical.articleId) throw invalid("記事IDとURLが一致しません。");
    return { articleId: canonical.articleId, title: value.title, author: value.author, body: value.body, url: canonical.url };
  }
  function fresh(endpoint) { return { schemaVersion: 1, endpoint, conversation: null, activeArticleId: null, articles: [], requests: {} }; }
  function read(raw, endpoint) {
    if (raw === undefined) return fresh(endpoint);
    if (!raw || raw.schemaVersion !== 1 || raw.endpoint !== endpoint || !Array.isArray(raw.articles) || !raw.requests || typeof raw.requests !== "object" || Array.isArray(raw.requests)) throw new Error("記事セッションの保存状態を確認できません。");
    const result = structuredClone(raw), map = new Map();
    for (const item of result.articles) { const article = validate(item); if (map.has(article.articleId)) throw new Error("記事IDが重複しています。"); map.set(article.articleId, article); }
    if (result.conversation) result.conversation = globalThis.OshaberiNoteChatState.read(result.conversation, endpoint, id);
    result.activeArticleId ??= result.conversation?.turns.findLast(turn => turn.articleId)?.articleId ?? null;
    if (result.activeArticleId !== null && !map.has(result.activeArticleId)) throw new Error("対象記事の参照が不正です。");
    for (const [token, request] of Object.entries(result.requests)) {
      if (!/^[a-zA-Z0-9-]{36}$/.test(token) || !request || !map.has(request.articleId) || request.action !== "summary" || typeof request.epoch !== "string") throw new Error("記事受け渡し情報が不正です。");
    }
    bounded(result); return result;
  }
  function bounded(session) {
    if (new TextEncoder().encode(JSON.stringify(session)).length > maxBytes || Object.keys(session.requests).length > 64) throw invalid("記事セッションの容量上限です。「記事について」で新しい会話を始めてから取り込んでください。記事を自動で削除・切り捨てることはしません。");
  }
  function display(article, action) { if (!actions[action]) throw invalid("記事の操作を確認してください。"); return `[&${article.title}]${actions[action].suffix}`; }
  function request(session, patch, epoch) {
    const map = new Map(session.articles.map(article => [article.articleId, article]));
    let articleId = patch.articleId, action = patch.articleAction;
    if (patch.requestToken) {
      const pending = session.requests[patch.requestToken];
      if (!pending || pending.epoch !== epoch) throw invalid("この記事の依頼は処理済みか、会話の初期化で無効になりました。自動再送は行いません。");
      articleId = pending.articleId; action = pending.action;
    }
    if (!articleId && !action) {
      articleId = session.activeArticleId;
      if (!articleId) throw invalid("対象の記事がありません。記事ページから取り込んでください。");
      action = "question";
    }
    const article = map.get(articleId);
    if (!article || (action !== "question" && !actions[action])) throw invalid("参照する記事がありません。記事ページから取り込み直してください。");
    const instruction = action === "question" ? patch.text : actions[action].instruction;
    const llmText = `${instruction}\nーーー\nタイトル：${article.title}\n著者：${article.author}\n本文：\n${article.body}`;
    if (llmText.length > 200000) throw invalid("記事と依頼文が送信上限200,000文字を超えています。本文は切り捨てず、送信を中止しました。");
    return { user: action === "question" ? patch.text : display(article, action), llmText, articleId, articleTitle: article.title, articleAction: action };
  }
  function extract(doc, win, url) {
    const address = page(url), article = doc.querySelector('article[id="note-article"]');
    const bodies = article?.querySelectorAll('[id="note-body"]');
    const visible = node => {
      for (let current = node; current?.nodeType === 1; current = current.parentElement) {
        const style = win.getComputedStyle(current);
        if (current.hidden || current.getAttribute("aria-hidden") === "true" || style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity === "0" || style.contentVisibility === "hidden") return false;
      }
      return true;
    };
    const visibleText = node => (typeof node.innerText === "string" ? node.innerText : node.textContent).trim();
    if (!article || bodies?.length !== 1 || bodies[0].getAttribute("data-name") !== "body" || !visible(article) || !visible(bodies[0])) throw invalid("閲覧できる記事本文を特定できません。");
    const headings = [...article.querySelectorAll("h1")].filter(node => !node.closest('[id="note-body"]') && visible(node));
    if (headings.length !== 1) throw invalid("記事タイトルを特定できません。");
    let author = "";
    for (const time of article.querySelectorAll("time")) {
      if (time.closest('[id="note-body"]')) continue;
      let region = time.parentElement;
      for (let depth = 0; region && region !== article && depth < 4; depth++, region = region.parentElement) {
        if (region.querySelector('[id="note-body"]')) break;
        const name = [...region.querySelectorAll("a[href]")].find(a => a.href.replace(/\/$/, "") === address.authorUrl && a.textContent.trim() && visible(a));
        if (name) { author = visibleText(name); break; }
      }
      if (author) break;
    }
    const chunks = [], excluded = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "NAV", "ASIDE", "BUTTON", "FORM", "INPUT", "TEXTAREA", "SVG", "CANVAS", "AUDIO", "VIDEO", "TITLE", "META", "LINK"]);
    const blocks = new Set(["P", "DIV", "SECTION", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "FIGCAPTION"]);
    function walk(node) {
      if (node.nodeType === 3) { chunks.push(node.nodeValue); return; }
      if (node.nodeType !== 1 || excluded.has(node.tagName) || node.hasAttribute("data-oshaberi-note-owned") || !visible(node)) return;
      if (node.tagName === "BR") { chunks.push("\n"); return; }
      if (blocks.has(node.tagName)) chunks.push("\n");
      for (const child of node.childNodes) walk(child);
      if (blocks.has(node.tagName)) chunks.push("\n");
    }
    walk(bodies[0]);
    return validate({ ...address, title: visibleText(headings[0]), author, body: chunks.join("").replace(/\n{3,}/g, "\n\n").trim() });
  }
  globalThis.OshaberiNoteArticles = Object.freeze({ id, key, actions, page, validate, fresh, read, bounded, display, request, extract });
})();
