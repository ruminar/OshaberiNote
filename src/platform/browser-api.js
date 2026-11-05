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
      if (settings.ollamaUrl !== previous.ollamaUrl) nextChat = chat.fresh(settings.ollamaUrl);
      else if (settings.ollamaSystemPrompt !== previous.ollamaSystemPrompt) {
        const previousChat = chat.read((await api.storage.local.get(chatKey))[chatKey], previous.ollamaUrl);
        nextChat = chat.fresh(settings.ollamaUrl);
        if (!options.importing) nextChat.approvedUrl = previousChat.approvedUrl;
      }
      else if (settings.enabled === false || settings.ollamaModel !== previous.ollamaModel || options.importing) {
        nextChat = chat.interrupt(chat.read((await api.storage.local.get(chatKey))[chatKey], previous.ollamaUrl));
        if (options.importing) nextChat.approvedUrl = "";
      }
      await api.storage.local.set({ [key]: settings, ...(nextChat ? { [chatKey]: nextChat } : {}) });
    },
    loadChat: async () => (await api.storage.local.get(chatKey))[chatKey],
    storeChat: state => api.storage.local.set({ [chatKey]: state }),
    hasPermission: endpoint => api.permissions.contains({ origins: [new URL(endpoint).protocol + "//" + new URL(endpoint).hostname + "/*"], ...(firefox ? { data_collection: ["personalCommunications"] } : {}) }),
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
