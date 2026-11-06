/* 拡張APIの差分はこのファイル内に閉じ込める。 */
(() => {
  "use strict";
  const api = globalThis.browser ?? globalThis.chrome;
  const firefox = Boolean(api?.runtime?.getManifest?.().browser_specific_settings?.gecko);
  const key = globalThis.OshaberiNote.settingsKey;
  const chatKey = "oshaberiNote.chat.v1";
  let queue = Promise.resolve();
  const chatOwners = new Set();
  function run(task) { const result = queue.then(task); queue = result.catch(() => {}); return result; }
  const articles = globalThis.OshaberiNoteArticles;
  const articleStore = globalThis.OshaberiNoteArticleStore;
  async function requestSession() {
    const key = articles.requestSessionKey;
    const current = (await api.storage.session.get(key))[key];
    if (typeof current === "string" && /^[a-zA-Z0-9-]{36}$/.test(current)) return current;
    const id = crypto.randomUUID(); await api.storage.session.set({ [key]: id }); return id;
  }
  async function writeArticle(value, localPatch = {}) {
    if (value !== undefined) articles.bounded(value);
    const previous = await articleStore.get();
    const changed = JSON.stringify(previous) !== JSON.stringify(value);
    if (changed) await articleStore.set(value);
    try {
      if (changed || Object.keys(localPatch).length) await api.storage.local.set({ ...localPatch, ...(changed ? { [articles.signalKey]: crypto.randomUUID() } : {}) });
    } catch (error) {
      if (changed) {
        try { if (previous === undefined) await articleStore.remove(); else await articleStore.set(previous); }
        catch { throw new Error("設定と記事DBの保存結果を確認できません。再読み込みして確認してください。自動再送は行いません。"); }
      }
      throw error;
    }
  }
  async function articleRaw() {
    let value = await articleStore.get();
    const session = await requestSession();
    if (value === undefined) {
      const legacy = (await api.storage.session.get(articles.key))[articles.key];
      if (legacy !== undefined) {
        value = articles.read(legacy, legacy.endpoint); value.requestSessionId = session;
        await writeArticle(value);
        await api.storage.session.remove(articles.key);
      }
    }
    if (value !== undefined && value.requestSessionId !== session) {
      value = structuredClone(value); value.requests = {}; value.requestSessionId = session;
      if (value.conversation) globalThis.OshaberiNoteChatState.interrupt(value.conversation);
      await writeArticle(value);
    }
    return value;
  }
  async function loadChat() {
    const raw = (await api.storage.local.get(chatKey))[chatKey], temporary = await articleRaw();
    if (temporary === undefined) return raw;
    const settings = globalThis.OshaberiNote.readSettings((await api.storage.local.get(key))[key]);
    const session = articles.read(temporary, settings.ollamaUrl), store = globalThis.OshaberiNoteChatState.readStore(raw, settings.ollamaUrl);
    // 旧版が履歴へ複製した送信本文も、読込時にMapを残して取り除く。
    if (JSON.stringify(temporary) !== JSON.stringify(session)) await writeArticle(session);
    if (session.conversation) store.conversations.article = session.conversation;
    return store;
  }
  async function persistChat(store, options = {}, settingsPatch = {}) {
    const previous = await articleRaw(), local = structuredClone(store), conversation = local.conversations.article;
    delete local.conversations.article;
    let session;
    if (conversation || previous !== undefined || options.articleSession) {
      if (!articleStore || !api.storage.session) throw new Error("記事の保存機能を利用できません。");
      session = options.articleSession ?? (previous?.endpoint === store.endpoint ? articles.read(previous, store.endpoint) : articles.fresh(store.endpoint));
      if (conversation) {
        if (session.conversation && session.conversation.epoch !== conversation.epoch) session = articles.fresh(store.endpoint);
        session.conversation = structuredClone(conversation);
      } else {
        session = articles.fresh(store.endpoint);
        session.conversation = globalThis.OshaberiNoteChatState.fresh(store.endpoint, articles.id);
      }
      if (options.requestToken) delete session.requests[options.requestToken];
      if (options.articleId) session.activeArticleId = options.articleId;
      articles.bounded(session);
    }
    if (session !== undefined) session.requestSessionId = await requestSession();
    const oldLocal = (await api.storage.local.get(chatKey))[chatKey];
    const localPatch = { ...settingsPatch, ...(JSON.stringify(oldLocal) !== JSON.stringify(local) ? { [chatKey]: local } : {}) };
    if (session !== undefined) await writeArticle(session, localPatch);
    else if (Object.keys(localPatch).length) await api.storage.local.set(localPatch);
  }

  async function prepareArticleMessage(patch, state) {
    const session = articles.read(await articleRaw(), state.endpoint);
    return articles.request(session, patch, state.epoch, state);
  }
  async function articleOperation(operation, patch = {}, sender) {
    return run(async () => {
      if (!articles || !articleStore || !api.storage.session) throw new Error("記事の保存機能を利用できません。");
      const settings = globalThis.OshaberiNote.readSettings((await api.storage.local.get(key))[key]);
      if (operation === "import") {
        if (!settings.enabled || !isNoteSender(sender)) throw new Error("記事の取り込みが許可されていません。");
        const tab = await api.tabs.get(sender.tab.id);
        // note内の画面遷移ではsender.urlが最初の文書URLのままになる。
        // 送信元の信頼性は上で検証し、記事の同一性は現在のタブと取得時URLで確認する。
        let address;
        try {
          address = articles.page(tab.url);
          if (articles.page(patch.pageUrl).url !== address.url || tab.pendingUrl && articles.page(tab.pendingUrl).url !== address.url) throw new Error();
        } catch { throw new Error("記事ページが変更されました。取り込み直してください。"); }
        const article = articles.validate(patch.article);
        if (article.url !== address.url || article.articleId !== address.articleId) throw new Error("表示中の記事と取得した記事が一致しません。");
        const store = globalThis.OshaberiNoteChatState.readStore(await loadChat(), settings.ollamaUrl);
        const session = articles.read(await articleRaw(), settings.ollamaUrl);
        session.conversation ??= globalThis.OshaberiNoteChatState.fresh(settings.ollamaUrl, articles.id);
        const map = new Map(session.articles.map(item => [item.articleId, item])); map.set(article.articleId, article); session.articles = [...map.values()];
        session.activeArticleId = article.articleId;
        const token = crypto.randomUUID(); session.requests[token] = { articleId: article.articleId, action: "summary", epoch: session.conversation.epoch };
        articles.request(session, { requestToken: token }, session.conversation.epoch);
        store.conversations.article = session.conversation; store.selectedActionId = articles.id;
        await persistChat(store, { articleSession: session });
        try { await api.tabs.create({ url: api.runtime.getURL("home.html") + "#article-request=" + token }); }
        catch (error) { delete session.requests[token]; await writeArticle(session); throw error; }
        return { opened: true };
      }
      const session = articles.read(await articleRaw(), settings.ollamaUrl);
      if (operation === "snapshot") return { endpoint: session.endpoint, conversation: session.conversation, articles: session.articles.map(({ articleId, title, author, url }) => ({ articleId, title, author, url })) };
      if (operation === "cancel") {
        if (typeof patch.requestToken === "string" && Object.hasOwn(session.requests, patch.requestToken)) {
          delete session.requests[patch.requestToken];
          await writeArticle(session);
        }
        return { cancelled: true };
      }
      if (operation === "request") {
        if (typeof patch.requestToken !== "string" || !Object.hasOwn(session.requests, patch.requestToken)) throw Object.assign(new Error("この記事の依頼は処理済みか無効です。自動再送は行いません。"), { code: "INVALID_INPUT" });
        const message = articles.request(session, { requestToken: patch.requestToken }, session.conversation?.epoch);
        return { articleId: message.articleId, articleAction: message.articleAction, displayText: message.user, requestToken: patch.requestToken };
      }
      if (operation === "info") {
        if (patch.epoch !== session.conversation?.epoch) throw new Error("記事の会話が変更されました。");
        const article = session.articles.find(item => item.articleId === patch.articleId);
        if (!article) throw new Error("記事情報がありません。記事ページから取り込み直してください。");
        return { articleId: article.articleId, title: article.title };
      }
      throw new Error("記事操作が不正です。");
    });
  }
  function isNoteSender(sender) {
    if (sender?.id !== api.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return false;
    try { return new URL(sender.url).origin === "https://note.com"; }
    catch { return false; }
  }
  async function request(type, patch) {
    let result;
    try { result = await api.runtime.sendMessage({ type, patch }); }
    catch { throw Object.assign(new Error("保存結果を確認できません。状態を再確認してください。操作は自動再送しません。"), { code: "UNCONFIRMED" }); }
    if (!result?.ok) throw Object.assign(new Error(result?.error ?? "拡張の背景処理に接続できません。状態を再確認してください。"), { code: result?.code ?? "UNCONFIRMED" });
    return result.settings;
  }
  globalThis.OshaberiNotePlatform = Object.freeze({
    isAvailable: () => Boolean(api?.runtime?.id),
    async load() {
      const result = await api.storage.local.get(key);
      return result[key];
    },
    homeUrl: () => api.runtime.getURL("home.html"),
    goBackUnrestricted: () => globalThis.history.back(),
    getState: () => request("get-state"),
    save: patch => request("save-settings", patch),
    saveLLM: (settings, expectedToken) => request("save-llm-settings", { settings, expectedToken }),
    importSettings: patch => request("import-settings", patch),
    author: operation => request("author-operation", operation),
    currentAuthor: (operation, source) => request("current-author-operation", { operation, source, pageUrl: globalThis.location.href }),
    addCurrentUser: (groupId, userId, displayName) => request("add-current-user", { groupId, userId, displayName, pageUrl: globalThis.location.href }),
    addCurrentMagazine: (groupId, userId, magazineId, displayName) => request("add-current-magazine", { groupId, userId, magazineId, displayName, pageUrl: globalThis.location.href }),
    addCurrentMembership: (groupId, userId, displayName) => request("add-current-membership", { groupId, userId, displayName, pageUrl: globalThis.location.href }),
    tag: operation => request("tag-operation", operation),
    article: (operation, patch) => request("article-operation", { operation, ...patch }),
    importArticle: article => request("import-article", { article, pageUrl: globalThis.location.href }),
    addCurrentTag: (groupId, selectionRevision) => request("add-current-tag", { groupId, selectionRevision, pageUrl: globalThis.location.href }),
    selectGroup: groupId => request("select-tag-group", { groupId, pageUrl: globalThis.location.href }),
    subscribe(listener) {
      const onChange = (changes, area) => {
        if (area === "local" && Object.hasOwn(changes, key)) listener(changes[key].newValue);
      };
      api.storage.onChanged.addListener(onChange);
      return () => api.storage.onChanged.removeListener(onChange);
    }
  });
  // このポートは背景処理（Service Worker / Firefox Event Page）だけで使用する。
  globalThis.OshaberiNoteBackgroundPlatform = Object.freeze({
    run,
    load: async () => (await api.storage.local.get(key))[key],
    async store(settings, options = {}) {
      const previous = globalThis.OshaberiNote.readSettings((await api.storage.local.get(key))[key]);
      const chat = globalThis.OshaberiNoteChatState;
      let nextChat;
      if (settings.ollamaUrl !== previous.ollamaUrl) {
        nextChat = chat.freshStore(settings.ollamaUrl);
        nextChat.selectedActionId = chat.preferredAction((await api.storage.local.get(chatKey))[chatKey]);
      }
      else if (settings.ollamaSystemPrompt !== previous.ollamaSystemPrompt) {
        nextChat = chat.readStore(await loadChat(), previous.ollamaUrl, "chat");
        nextChat.conversations.chat = chat.fresh(settings.ollamaUrl);
        if (options.importing) { chat.interruptStore(nextChat); nextChat.approvedUrl = ""; }
      }
      else if (settings.enabled === false || settings.ollamaModel !== previous.ollamaModel || options.importing) {
        nextChat = chat.interruptStore(chat.readStore(await loadChat(), previous.ollamaUrl));
        if (options.importing) nextChat.approvedUrl = "";
      }
      if (nextChat) await persistChat(nextChat, {}, { [key]: settings });
      else await api.storage.local.set({ [key]: settings });
    },
    loadChat, storeChat: persistChat, prepareArticleMessage, articleOperation,
    hasPermission: (endpoint, options = {}) => api.permissions.contains({ origins: [new URL(endpoint).protocol + "//" + new URL(endpoint).hostname + "/*"], ...(firefox ? { data_collection: ["personalCommunications", ...(options.article ? ["websiteContent"] : [])] } : {}) }),
    onChatDisconnect: listener => api.runtime.onConnect.addListener(connection => {
      if (!globalThis.OshaberiNoteBackgroundPlatform.isHomeSender(connection.sender) || !connection.name.startsWith("oshaberi-chat:")) return;
      const owner = connection.name.slice("oshaberi-chat:".length);
      chatOwners.add(owner);
      connection.onMessage.addListener(() => {});
      connection.onDisconnect.addListener(() => { chatOwners.delete(owner); listener(owner); });
    }),
    isChatOwnerConnected: owner => chatOwners.has(owner),
    onPermissionRemoved: listener => api.permissions.onRemoved.addListener(listener),
    setRules: rules => api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2, 3, 4], addRules: rules }),
    onMessage: listener => api.runtime.onMessage.addListener(listener),
    onInstalled: listener => api.runtime.onInstalled.addListener(listener),
    onStartup: listener => api.runtime.onStartup.addListener(listener),
    onAction: listener => api.action.onClicked.addListener(listener),
    openHome: (activationFailed = false) => api.tabs.create({
      url: api.runtime.getURL("home.html") + (activationFailed ? "#activation-failed" : "")
    }),
    isNoteSender,
    async currentMembershipPage(sender, pageUrl) {
      if (!isNoteSender(sender)) return null;
      try {
        const tab = await api.tabs.get(sender.tab.id), current = new URL(tab.url);
        if (current.origin !== "https://note.com" || new URL(pageUrl).href !== current.href ||
            (tab.pendingUrl && new URL(tab.pendingUrl).href !== current.href)) return null;
        return globalThis.OshaberiNote.membershipPage(current.href);
      } catch { return null; }
    },
    async currentMagazinePage(sender, pageUrl) {
      if (!isNoteSender(sender)) return null;
      try {
        const tab = await api.tabs.get(sender.tab.id), current = new URL(tab.url);
        if (current.origin !== "https://note.com" || new URL(pageUrl).href !== current.href ||
            (tab.pendingUrl && new URL(tab.pendingUrl).href !== current.href)) return null;
        const page = globalThis.OshaberiNote.pageKind(current.href);
        return page?.type === "magazine" ? page : null;
      } catch { return null; }
    },
    async currentAuthorPage(sender, pageUrl) {
      if (!isNoteSender(sender)) return null;
      try {
        const tab = await api.tabs.get(sender.tab.id), current = new URL(tab.url);
        if (current.origin !== "https://note.com" || new URL(pageUrl).href !== current.href ||
            (tab.pendingUrl && new URL(tab.pendingUrl).href !== current.href)) return null;
        const core = globalThis.OshaberiNote;
        if (core.isArticle(current.href)) return { type: "article", user: core.authorId(current.pathname.split("/")[1]) };
        const page = core.pageKind(current.href);
        return page?.type === "profile" ? { type: "profile", user: core.authorId(page.user) } : null;
      } catch { return null; }
    },
    async currentMenuPage(sender, pageUrl) {
      if (!isNoteSender(sender)) return null;
      try {
        // sender.urlはSPA遷移後の表示URLと異なる場合がある。ホスト権限で現在のタブを確認する。
        const tab = await api.tabs.get(sender.tab.id);
        const current = new URL(tab.url);
        if (current.origin !== "https://note.com" || new URL(pageUrl).href !== current.href) return null;
        if (tab.pendingUrl && new URL(tab.pendingUrl).href !== current.href) return null;
        const page = globalThis.OshaberiNote.pageKind(current.href);
        return ["following", "tag", "search", "topic"].includes(page?.type) ? page : null;
      } catch { return null; }
    },
    isHomeSender: sender => sender?.id === api.runtime.id &&
      sender.url?.split(/[?#]/)[0] === api.runtime.getURL("home.html")
  });
})();
