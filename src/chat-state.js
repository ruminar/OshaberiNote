/* 会話の保存は背景処理の単一キューを経由する。note上へ公開しない。 */
(() => {
  "use strict";
  const core = globalThis.OshaberiNote;
  const key = "oshaberiNote.chat.v1";
  const limits = Object.freeze({ input: 200000, response: 32000, context: 256000, turns: 10, bytes: 2097152 });
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  function fresh(endpoint, actionId = "chat") { return { schemaVersion: 1, epoch: crypto.randomUUID(), endpoint, actionId, approvedUrl: "", turns: [], active: null, droppedTurns: 0, contextTrimmedTurns: 0 }; }
  function readConversation(raw, endpoint) {
    if (raw === undefined) return fresh(endpoint);
    // 以前の100往復までの履歴は読み込んだ後、現在の保存範囲へ移行する。
    if (!raw || raw.schemaVersion !== 1 || typeof raw.epoch !== "string" || raw.endpoint !== endpoint || !["", endpoint].includes(raw.approvedUrl) || !Array.isArray(raw.turns) || raw.turns.length > 100 || bytes(raw) > limits.bytes) throw new Error("会話の保存データに異常があります。「新しい会話」で初期化してください。");
    if (raw.turns.some(turn => !turn || typeof turn.user !== "string" || !turn.user.trim() || turn.user.length > limits.input || typeof turn.assistant !== "string" || turn.assistant.length > limits.response || !["complete", "interrupted", "pending"].includes(turn.status))) throw new Error("会話履歴の形式が不正です。");
    for (const turn of raw.turns) {
      if (turn.llmText !== undefined && (raw.actionId !== "article" || typeof turn.llmText !== "string" || !turn.llmText.trim() || turn.llmText.length > limits.input)) throw new Error("記事の送信本文が不正です。");
      if (turn.articleId !== undefined && (raw.actionId !== "article" || !/^n[a-zA-Z0-9]+$/.test(turn.articleId) || typeof turn.articleTitle !== "string" || !turn.articleTitle.trim() || turn.articleTitle.length > 500 || !["summary", "impression", "revision", "question"].includes(turn.articleAction))) throw new Error("記事の参照情報が不正です。");
    }
    if (raw.active !== null && (!raw.active || typeof raw.active.id !== "string" || typeof raw.active.owner !== "string" || raw.turns.at(-1)?.status !== "pending")) throw new Error("生成状態が不正です。");
    if (raw.turns.filter(turn => turn.status === "pending").length !== (raw.active ? 1 : 0)) throw new Error("未完了の生成状態が不正です。");
    if (raw.actionId !== undefined && raw.actionId !== "chat" && !globalThis.OshaberiNoteChatActions?.find(raw.actionId)) throw new Error("未対応の会話の種類です。");
    for (const key of ["droppedTurns", "contextTrimmedTurns"]) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || raw[key] < 0)) throw new Error("履歴の整理状態が不正です。");
    const result = { ...structuredClone(raw), actionId: raw.actionId ?? "chat", droppedTurns: raw.droppedTurns ?? 0, contextTrimmedTurns: raw.contextTrimmedTurns ?? 0 };
    if (result.actionId === "article") for (const turn of result.turns) delete turn.llmText;
    return result;
  }
  const validAction = id => id === "chat" || Boolean(globalThis.OshaberiNoteChatActions?.find(id));
  const preferredAction = raw => validAction(raw?.selectedActionId) ? raw.selectedActionId : "chat";
  function freshStore(endpoint) { return { schemaVersion: 2, endpoint, selectedActionId: "chat", approvedUrl: "", conversations: {} }; }
  function readStore(raw, endpoint, resetId) {
    if (raw === undefined) return freshStore(endpoint);
    if (raw?.schemaVersion === 1) {
      const store = freshStore(endpoint);
      if (resetId && (raw.actionId ?? "chat") === resetId) {
        if (raw.approvedUrl === endpoint) store.approvedUrl = endpoint;
        return store;
      }
      const state = readConversation(raw, endpoint);
      store.approvedUrl = state.approvedUrl; store.conversations[state.actionId] = state;
      return store;
    }
    if (!raw || raw.schemaVersion !== 2 || raw.endpoint !== endpoint || !["", endpoint].includes(raw.approvedUrl) ||
        !raw.conversations || typeof raw.conversations !== "object" || Array.isArray(raw.conversations) ||
        Object.keys(raw.conversations).some(id => !validAction(id))) throw new Error("会話の保存データに異常があります。状態を確認してください。");
    const store = freshStore(endpoint); store.approvedUrl = raw.approvedUrl; store.selectedActionId = preferredAction(raw);
    for (const [id, value] of Object.entries(raw.conversations)) {
      if (id === resetId) continue;
      const state = readConversation(value, endpoint);
      if (state.actionId !== id) throw new Error("会話の種類と保存先が一致しません。");
      store.conversations[id] = state;
    }
    return store;
  }
  function select(store, id = "chat") {
    if (!validAction(id)) throw new Error("未対応の会話の種類です。");
    const state = store.conversations[id] ?? fresh(store.endpoint, id);
    state.approvedUrl = store.approvedUrl;
    return state;
  }
  function read(raw, endpoint, id = "chat") { return select(readStore(raw, endpoint), id); }
  function interruptStore(store) {
    for (const state of Object.values(store.conversations)) interrupt(state);
    return store;
  }
  function retainRecent(state, reserve = 0) {
    while (state.turns.length > limits.turns || bytes(state) + reserve > limits.bytes) {
      if (state.turns.length <= 1 || state.turns[0].status === "pending") throw new Error("最新の入力を保存できません。入力を短くしてください。");
      state.turns.shift();
      state.droppedTurns = Math.min(Number.MAX_SAFE_INTEGER, state.droppedTurns + 1);
    }
    return state;
  }
  function messagesFor(state, settings, text) {
    const system = globalThis.OshaberiNoteChatActions.systemPrompt(state.actionId, settings);
    if (system.length + text.length > limits.context) throw Object.assign(new Error("システムプロンプトと今回の入力が送信上限を超えています。入力または登録済みタグを整理してください。"), { code: "INVALID_INPUT" });
    if (state.actionId === "article") {
      state.contextTrimmedTurns = 0;
      return [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: text }];
    }
    let remaining = limits.context - system.length - text.length;
    const complete = state.turns.filter(turn => turn.status === "complete"), selected = [];
    for (let i = complete.length - 1; i >= 0; i--) {
      const turn = complete[i], length = turn.user.length + turn.assistant.length;
      if (length > remaining) break;
      selected.unshift(turn); remaining -= length;
    }
    state.contextTrimmedTurns = complete.length - selected.length;
    return [...(system !== "" ? [{ role: "system", content: system }] : []),
      ...selected.flatMap(turn => [{ role: "user", content: turn.user }, { role: "assistant", content: turn.assistant }]),
      { role: "user", content: text }];
  }
  function interrupt(state) {
    if (state.turns.at(-1)?.status === "pending") state.turns.at(-1).status = "interrupted";
    state.active = null;
    return state;
  }
  function createController(port, run) {
    async function load() {
      const raw = await port.loadSettings();
      if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.enabled !== "boolean")) throw new Error("拡張のON/OFF保存値が不正です。設定を確認してください。");
      const settings = core.readSettings(raw);
      core.normalizeOllamaUrl(settings.ollamaUrl); core.validateModel(settings.ollamaModel); core.validateSystemPrompt(settings.ollamaSystemPrompt);
      return settings;
    }
    async function permitted(settings, store, actionId) {
      if (!settings.enabled || store.approvedUrl !== settings.ollamaUrl || !await port.hasPermission(settings.ollamaUrl, { article: actionId === "article" })) throw new Error("接続が未許可です。拡張をONにし、「接続・再試行」から接続してください。");
    }
    function view(store, state) { return { ...state, anyActive: Object.values(store.conversations).some(item => Boolean(item.active)) }; }
    async function save(store, state, options) {
      if (state) { retainRecent(state); store.conversations[state.actionId] = state; }
      await port.store(store, options); return state ? view(store, state) : undefined;
    }
    return Object.freeze({ execute: (operation, patch = {}) => run(async () => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("会話の要求が不正です。");
      const settings = await load(), requestedId = patch.actionId ?? "chat";
      if (!validAction(requestedId)) throw new Error("未対応の会話の種類です。");
      const raw = await port.load();
      const store = readStore(raw, settings.ollamaUrl, operation === "reset" ? requestedId : undefined);
      const id = operation === "restore" ? store.selectedActionId : requestedId;
      let state = select(store, id);
      if (operation === "reset") {
        state = fresh(settings.ollamaUrl, id); state.approvedUrl = store.approvedUrl;
        return save(store, state);
      }
      if (operation === "get" || operation === "restore") {
        let orphan = false;
        for (const item of Object.values(store.conversations)) {
          if (item.active && port.isOwnerConnected && !port.isOwnerConnected(item.active.owner)) { interrupt(item); orphan = true; }
        }
        // 初回生成したepochと旧単一会話の移行も、同じ保存キューで確定する。
        if (orphan || raw?.schemaVersion !== 2 || !Object.hasOwn(store.conversations, id) || state.turns.length > limits.turns) return save(store, state);
        return view(store, state);
      }
      if (operation === "select") {
        if (typeof patch.owner !== "string" || !port.isOwnerConnected?.(patch.owner)) throw new Error("会話画面との接続を確認できません。");
        const first = !Object.hasOwn(store.conversations, id);
        for (const item of Object.values(store.conversations)) {
          if (item.active && (item.active.owner === patch.owner || (port.isOwnerConnected && !port.isOwnerConnected(item.active.owner)))) interrupt(item);
        }
        if (state.active?.owner === patch.owner) interrupt(state);
        store.selectedActionId = id;
        const selected = await save(store, state);
        const action = globalThis.OshaberiNoteChatActions.find(id);
        return { ...selected, ...(first && action?.initialMessage ? { initialMessage: action.initialMessage } : {}) };
      }
      if (operation === "stop" || operation === "revoke") {
        for (const item of Object.values(store.conversations)) {
          if (operation === "stop" && ((patch.actionId && item.actionId !== patch.actionId) || (patch.owner && item.active?.owner !== patch.owner) || (patch.id && item.active?.id !== patch.id))) continue;
          interrupt(item);
        }
        if (operation === "revoke") store.approvedUrl = "";
        state = select(store, id); await save(store); return view(store, state);
      }
      if (patch.epoch !== state.epoch || patch.endpoint !== settings.ollamaUrl) throw Object.assign(new Error("接続先または会話が変更されました。状態を再確認してください。"), { code: "STALE_CHAT" });
      if (operation === "approve") {
        if (!settings.enabled || !await port.hasPermission(settings.ollamaUrl, { article: id === "article" })) throw new Error("接続先への権限がありません。");
        store.approvedUrl = settings.ollamaUrl; state.approvedUrl = store.approvedUrl; return save(store, state);
      }
      await permitted(settings, store, id);
      if (operation === "start") {
        if (Object.values(store.conversations).some(item => item.active)) throw Object.assign(new Error("別の画面またはタブで応答を生成中です。終了するまで待ってください。"), { code: "CHAT_BUSY" });
        if (!settings.ollamaModel || patch.model !== settings.ollamaModel) throw new Error("モデルを選択し直してください。");
        if (typeof patch.owner !== "string" || patch.owner.length > 100 || !patch.owner || typeof patch.text !== "string" || !patch.text.trim() || patch.text.length > limits.input) throw Object.assign(new Error("メッセージは1～200,000文字で入力してください。入力を直して、そのまま再送できます。"), { code: "INVALID_INPUT" });
        if (port.isOwnerConnected && !port.isOwnerConnected(patch.owner)) throw new Error("会話画面との接続を確認できません。再読み込みしてください。");
        const message = id === "article" ? await port.prepareArticleMessage(patch, state) : { user: patch.text };
        const { llmText, ...displayMessage } = message;
        state.turns.push({ ...displayMessage, assistant: "", status: "pending" }); state.active = { id: crypto.randomUUID(), owner: patch.owner };
        retainRecent(state, limits.response * 6);
        const messages = messagesFor(state, settings, llmText ?? message.user);
        const started = await save(store, state, { requestToken: patch.requestToken, articleId: message.articleId }); return { ...started, messages };
      }
      if (!["progress", "complete"].includes(operation) || !state.active || patch.id !== state.active.id || patch.owner !== state.active.owner || patch.model !== settings.ollamaModel) throw Object.assign(new Error("生成は中止または初期化されました。"), { code: "STALE_CHAT" });
      if (typeof patch.text !== "string" || patch.text.length > limits.response || !patch.text.startsWith(state.turns.at(-1).assistant)) throw new Error("応答の形式または長さが不正です。");
      state.turns.at(-1).assistant = patch.text;
      if (operation === "complete") { state.turns.at(-1).status = "complete"; state.active = null; }
      return save(store, state);
    }) });
  }
  globalThis.OshaberiNoteChatState = Object.freeze({ key, limits, bytes, fresh, freshStore, preferredAction, read, readStore, interrupt, interruptStore, retainRecent, createController });
})();
