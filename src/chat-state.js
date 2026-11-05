/* 会話の保存は背景処理の単一キューを経由する。note上へ公開しない。 */
(() => {
  "use strict";
  const core = globalThis.OshaberiNote;
  const key = "oshaberiNote.chat.v1";
  const limits = Object.freeze({ input: 8000, response: 32000, context: 32000, turns: 100, bytes: 1048576 });
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  function fresh(endpoint) { return { schemaVersion: 1, epoch: crypto.randomUUID(), endpoint, approvedUrl: "", turns: [], active: null }; }
  function read(raw, endpoint) {
    if (raw === undefined) return fresh(endpoint);
    if (!raw || raw.schemaVersion !== 1 || typeof raw.epoch !== "string" || raw.endpoint !== endpoint || !["", endpoint].includes(raw.approvedUrl) || !Array.isArray(raw.turns) || raw.turns.length > limits.turns || bytes(raw) > limits.bytes) throw new Error("会話の保存データに異常があります。「新しい会話」で初期化してください。");
    if (raw.turns.some(turn => !turn || typeof turn.user !== "string" || !turn.user.trim() || turn.user.length > limits.input || typeof turn.assistant !== "string" || turn.assistant.length > limits.response || !["complete", "interrupted", "pending"].includes(turn.status))) throw new Error("会話履歴の形式が不正です。");
    if (raw.active !== null && (!raw.active || typeof raw.active.id !== "string" || typeof raw.active.owner !== "string" || raw.turns.at(-1)?.status !== "pending")) throw new Error("生成状態が不正です。");
    if (raw.turns.filter(turn => turn.status === "pending").length !== (raw.active ? 1 : 0)) throw new Error("未完了の生成状態が不正です。");
    return structuredClone(raw);
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
      const state = read(await port.load(), settings.ollamaUrl);
      return { settings, state };
    }
    async function permitted(settings, state) {
      if (!settings.enabled || state.approvedUrl !== settings.ollamaUrl || !await port.hasPermission(settings.ollamaUrl)) throw new Error("接続が未許可です。拡張をONにし、「接続・再試行」から接続してください。");
    }
    async function save(state) {
      if (bytes(state) > limits.bytes) throw new Error("会話の保存上限に達しました。「新しい会話」で初期化してください。");
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
          if (await port.load() === undefined) return save(state);
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
        if (operation === "start") {
          if (state.active) throw new Error("別の画面で応答を生成中です。中止してから再試行してください。");
          if (!settings.ollamaModel || patch.model !== settings.ollamaModel) throw new Error("モデルを選択し直してください。");
          if (typeof patch.owner !== "string" || patch.owner.length > 100 || !patch.owner || typeof patch.text !== "string" || !patch.text.trim() || patch.text.length > limits.input) throw new Error("メッセージは1～8,000文字で入力してください。");
          if (port.isOwnerConnected && !port.isOwnerConnected(patch.owner)) throw new Error("会話画面との接続を確認できません。再読み込みしてください。");
          const messages = state.turns.filter(turn => turn.status === "complete").flatMap(turn => [{ role: "user", content: turn.user }, { role: "assistant", content: turn.assistant }]);
          messages.push({ role: "user", content: patch.text });
          if (messages.reduce((n, item) => n + item.content.length, 0) > limits.context || state.turns.length >= limits.turns) throw new Error("会話の上限に達しました。「新しい会話」で初期化してください。");
          state.turns.push({ user: patch.text, assistant: "", status: "pending" });
          state.active = { id: crypto.randomUUID(), owner: patch.owner };
          if (bytes(state) + limits.response * 6 > limits.bytes) throw new Error("会話の保存上限に近づきました。「新しい会話」で初期化してください。");
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
  globalThis.OshaberiNoteChatState = Object.freeze({ key, limits, bytes, fresh, read, interrupt, createController });
})();
