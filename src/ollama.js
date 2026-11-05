/* ストリームの境界とJSON行の境界は一致しない。外部コードは実行しない。 */
(() => {
  "use strict";
  async function request(endpoint, path, options, signal) {
    const response = await fetch(endpoint + path, { ...options, signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    if (!response.ok) {
      const action = path === "/api/chat" ? "会話送信" : "モデル一覧の取得";
      throw Object.assign(new Error(response.status === 403
        ? `Ollamaが${action}を拒否しました（HTTP 403）。接続先のOrigin許可設定を確認してください。`
        : `Ollamaの${action}に失敗しました（HTTP ${response.status}）。`), { status: response.status, path });
    }
    if (!response.body) throw new Error("Ollamaの応答本文がありません。");
    return response;
  }
  async function readBounded(response, maximum, consume, signal) {
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) { await consume(decoder.decode(), true); break; }
        size += value.byteLength;
        if (size > maximum) throw new Error("Ollamaの応答サイズが上限を超えました。");
        await consume(decoder.decode(value, { stream: true }), false);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function models(endpoint, signal) {
    const response = await request(endpoint, "/api/tags", {}, signal);
    let text = "";
    await readBounded(response, 1048576, part => { text += part; }, signal);
    const result = JSON.parse(text);
    if (!Array.isArray(result.models) || result.models.length > 1000) throw new Error("モデル一覧の形式が不正です。");
    return [...new Set(result.models.map(model => {
      const name = globalThis.OshaberiNote.validateModel(model?.name);
      if (!name) throw new Error("モデル名が空です。");
      return name;
    }))];
  }
  async function chat(endpoint, model, messages, signal, onText) {
    const response = await request(endpoint, "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, stream: true, think: false, truncate: true, shift: true }) }, signal);
    let buffer = "", answer = "", finished = false;
    async function line(text) {
      if (!text.trim()) return;
      if (finished) throw new Error("完了後に余分な応答を受信しました。");
      const value = JSON.parse(text);
      if (value.error) throw new Error("Ollamaが生成エラーを返しました。モデルとOllamaの状態を確認してください。");
      if (!value.message || value.message.role !== "assistant" || typeof value.message.content !== "string" || typeof value.done !== "boolean") throw new Error("Ollamaの応答形式が不正です。");
      if (value.message.tool_calls?.length) throw new Error("ツールの実行要求には対応していません。");
      answer += value.message.content;
      if (answer.length > globalThis.OshaberiNoteChatState.limits.response) throw new Error("AI応答が32,000文字の上限を超えました。");
      await onText(answer);
      if (value.done) finished = true;
    }
    await readBounded(response, 4194304, async (part, end) => {
      buffer += part;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) { const text = buffer.slice(0, index); buffer = buffer.slice(index + 1); await line(text); }
      if (buffer.length > 262144) throw new Error("Ollamaの応答行が長すぎます。");
      if (end && buffer.trim()) { await line(buffer); buffer = ""; }
    }, signal);
    if (!finished) throw new Error("応答が完了前に切断されました。自動再送は行いません。");
    return answer;
  }
  globalThis.OshaberiNoteOllama = Object.freeze({ models, chat });
})();
