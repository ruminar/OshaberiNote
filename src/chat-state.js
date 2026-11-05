/* 会話の保存は背景処理の単一キューを経由する。note上へ公開しない。 */
(() => {
  "use strict";
  const core = globalThis.OshaberiNote;
  const key = "oshaberiNote.chat.v1";
  const limits = Object.freeze({ input: 200000, response: 32000, context: 256000, turns: 10, bytes: 2097152 });
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  function fresh(endpoint, actionId = "chat") { return { schemaVersion: 1, epoch: crypto.randomUUID(), endpoint, actionId, approvedUrl: "", turns: [], active: null, droppedTurns: 0, contextTrimmedTurns: 0 }; }
  function read(raw, endpoint) {
    if (raw === undefined) return fresh(endpoint);
    // 以前の100往復までの履歴は読み込んだ後、現在の保存範囲へ移行する。
    if (!raw || raw.schemaVersion !== 1 || typeof raw.epoch !== "string" || raw.endpoint !== endpoint || !["", endpoint].includes(raw.approvedUrl) || !Array.isArray(raw.turns) || raw.turns.length > 100 || bytes(raw) > limits.bytes) throw new Error("会話の保存データに異常があります。「新しい会話」で初期化してください。");
    if (raw.turns.some(turn => !turn || typeof turn.user !== "string" || !turn.user.trim() || turn.user.length > limits.input || typeof turn.assistant !== "string" || turn.assistant.length > limits.response || !["complete", "interrupted", "pending"].includes(turn.status))) throw new Error("会話履歴の形式が不正です。");
    if (raw.active !== null && (!raw.active || typeof raw.active.id !== "string" || typeof raw.active.owner !== "string" || raw.turns.at(-1)?.status !== "pending")) throw new Error("生成状態が不正です。");
    if (raw.turns.filter(turn => turn.status === "pending").length !== (raw.active ? 1 : 0)) throw new Error("未完了の生成状態が不正です。");
    if (raw.actionId !== undefined && raw.actionId !== "chat" && !globalThis.OshaberiNoteChatActions?.find(raw.actionId)) throw new Error("未対応の会話の種類です。");
    for (const key of ["droppedTurns", "contextTrimmedTurns"]) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || raw[key] < 0)) throw new Error("履歴の整理状態が不正です。");
    return { ...structuredClone(raw), actionId: raw.actionId ?? "chat", droppedTurns: raw.droppedTurns ?? 0, contextTrimmedTurns: raw.contextTrimmedTurns ?? 0 };
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
      core.normalizeOllamaUrl(settings.ollamaUrl); core.validateModel(settings.ollamaModel);
      core.validateSystemPrompt(settings.ollamaSystemPrompt);
      const state = read(await port.load(), settings.ollamaUrl);
      return { settings, state };
    }
    async function permitted(settings, state) {
      if (!settings.enabled || state.approvedUrl !== settings.ollamaUrl || !await port.hasPermission(settings.ollamaUrl)) throw new Error("接続が未許可です。拡張をONにし、「接続・再試行」から接続してください。");
    }
    async function save(state) {
      retainRecent(state);
      await port.store(state); return state;
    }
    return Object.freeze({
      execute: (operation, patch = {}) => run(async () => {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("会話の要求が不正です。");
        if (operation === "reset") {
          const settings = core.readSettings(await port.loadSettings());
          const previous = await port.load();
          const state = fresh(core.normalizeOllamaUrl(settings.ollamaUrl));
          if (previous?.approvedUrl === state.endpoint) state.approvedUrl = state.endpoint;
          return save(state);
        }
        const { settings, state } = await load();
        if (operation === "get") {
          if (state.active && port.isOwnerConnected && !port.isOwnerConnected(state.active.owner)) return save(interrupt(state));
          // 初回生成したepochも保存し、次の要求と同じ会話を参照する。
          if (await port.load() === undefined || state.turns.length > limits.turns) return save(state);
          return state;
        }
        if (operation === "stop") {
          if (patch.owner && state.active?.owner !== patch.owner) return state;
          if (patch.id && state.active?.id !== patch.id) return state;
          return save(interrupt(state));
        }
        if (operation === "revoke") { state.approvedUrl = ""; return save(interrupt(state)); }
        if (patch.epoch !== state.epoch || patch.endpoint !== settings.ollamaUrl) throw new Error("接続先または会話が変更されました。状態を再確認してください。");
        if (operation === "approve") {
          if (!settings.enabled || !await port.hasPermission(settings.ollamaUrl)) throw new Error("接続先への権限がありません。");
          state.approvedUrl = settings.ollamaUrl; return save(state);
        }
        await permitted(settings, state);
        if (operation === "begin-action") {
          const action = globalThis.OshaberiNoteChatActions.find(patch.actionId);
          if (!action || !settings.ollamaModel || patch.model !== settings.ollamaModel) throw new Error("会話の種類と使用モデルを確認してください。");
          const next = fresh(settings.ollamaUrl, action.id); next.approvedUrl = state.approvedUrl;
          // 送信に必要なデータを検証してから、元の会話を初期化する。
          messagesFor(next, settings, action.initialMessage);
          await save(next);
          return { ...next, initialMessage: action.initialMessage };
        }
        if (operation === "start") {
          if (state.active) throw new Error("別の画面で応答を生成中です。中止してから再試行してください。");
          if (!settings.ollamaModel || patch.model !== settings.ollamaModel) throw new Error("モデルを選択し直してください。");
          if (typeof patch.owner !== "string" || patch.owner.length > 100 || !patch.owner || typeof patch.text !== "string" || !patch.text.trim() || patch.text.length > limits.input) throw Object.assign(new Error("メッセージは1～200,000文字で入力してください。入力を直して、そのまま再送できます。"), { code: "INVALID_INPUT" });
          if (port.isOwnerConnected && !port.isOwnerConnected(patch.owner)) throw new Error("会話画面との接続を確認できません。再読み込みしてください。");
          state.turns.push({ user: patch.text, assistant: "", status: "pending" });
          state.active = { id: crypto.randomUUID(), owner: patch.owner };
          // 最新入力と最大応答用の容量を確保し、古い往復から整理する。
          retainRecent(state, limits.response * 6);
          const messages = messagesFor(state, settings, patch.text);
          await save(state);
          return { ...state, messages };
        }
        if (!["progress", "complete"].includes(operation) || !state.active || patch.id !== state.active.id || patch.owner !== state.active.owner || patch.model !== settings.ollamaModel) throw new Error("生成は中止または初期化されました。");
        if (typeof patch.text !== "string" || patch.text.length > limits.response || !patch.text.startsWith(state.turns.at(-1).assistant)) throw new Error("応答の形式または長さが不正です。");
        state.turns.at(-1).assistant = patch.text;
        if (operation === "complete") { state.turns.at(-1).status = "complete"; state.active = null; }
        return save(state);
      })
    });
  }
  globalThis.OshaberiNoteChatState = Object.freeze({ key, limits, bytes, fresh, read, interrupt, retainRecent, createController });
})();
