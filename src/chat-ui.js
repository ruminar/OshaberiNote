(() => {
  "use strict";
  const core = globalThis.OshaberiNote, platform = globalThis.OshaberiNotePlatform;
  const api = globalThis.browser ?? globalThis.chrome, byId = id => document.getElementById(id);
  const firefox = Boolean(api.runtime.getManifest?.().browser_specific_settings?.gecko);
  const owner = crypto.randomUUID(), chatKey = globalThis.OshaberiNoteChatState.key;
  let settings, state, connection, requestAbort, generatingId, ready = false, busy = false, blocked = false;
  let modelNames = [], probeRevision = 0, visible = !byId("panel-chat").hidden;
  const status = text => { byId("chat-status").textContent = text; };
  function connectionHelp(error) {
    const origin = api.runtime.getURL("").replace(/\/$/, "");
    const show = error?.status === 403 && /^(chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin);
    byId("ollama-origin-help").hidden = !show;
    if (show) {
      byId("ollama-extension-origin").textContent = origin;
      byId("ollama-origin-command").value = `$env:OLLAMA_ORIGINS = (@($env:OLLAMA_ORIGINS -split ',' | Where-Object { $_ }) + @('${origin}') | Select-Object -Unique) -join ','\nollama serve`;
    }
  }
  function controls() {
    const active = Boolean(state?.active);
    byId("connect-ollama").disabled = busy || !settings?.enabled || active || blocked;
    byId("chat-model").disabled = busy || !ready || blocked;
    byId("chat-input").disabled = busy || active || !settings?.enabled || blocked;
    byId("chat-send").disabled = busy || active || !ready || !settings?.ollamaModel || !settings?.enabled || blocked;
    byId("chat-stop").disabled = !active;
    byId("chat-new").disabled = busy || !settings;
    byId("save-ollama-url").disabled = busy || !settings;
  }
  function abort() { requestAbort?.abort(); requestAbort = undefined; probeRevision++; }
  async function call(operation, patch = {}) {
    let result;
    try { result = await api.runtime.sendMessage({ type: "chat-operation", operation, patch }); }
    catch { blocked = true; controls(); throw new Error("保存結果を確認できません。ページを再読み込みして状態を確認してください。自動再送は行いません。"); }
    if (!result?.ok) { blocked = true; controls(); throw new Error(result?.error || "会話の処理結果を確認できません。"); }
    return result.settings;
  }
  function renderModels() {
    const select = byId("chat-model"); select.replaceChildren();
    const empty = document.createElement("option"); empty.value = ""; empty.textContent = "モデルを選択してください"; select.append(empty);
    const names = [...new Set([...(settings?.ollamaModel ? [settings.ollamaModel] : []), ...modelNames])];
    for (const name of names) { const option = document.createElement("option"); option.value = name; option.textContent = name; select.append(option); }
    select.value = settings?.ollamaModel || "";
  }
  function render(next) {
    if (state && state.epoch !== next.epoch) { abort(); byId("chat-input").value = ""; }
    if (generatingId && next.active?.id !== generatingId) abort();
    state = next;
    const container = byId("chat-messages"), atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    container.replaceChildren();
    for (const turn of state.turns) {
      for (const [label, content] of [["あなた", turn.user], [turn.status === "complete" ? "AI" : turn.status === "pending" ? "AI（生成中・未完了）" : "AI（中断・次回送信の対象外）", turn.assistant]]) {
        const article = document.createElement("article"), heading = document.createElement("h3"), text = document.createElement("p");
        heading.textContent = label; text.textContent = content || "（応答なし）"; article.append(heading, text); container.append(article);
      }
    }
    if (!state.turns.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "新しい会話です。モデルを選んでメッセージを送ってください。"; container.append(empty); }
    if (atBottom) container.scrollTop = container.scrollHeight;
    controls();
  }
  async function sync() {
    settings = await platform.getState();
    byId("chat-endpoint").textContent = `接続先：${settings.ollamaUrl}`;
    if (document.activeElement !== byId("ollama-url")) byId("ollama-url").value = settings.ollamaUrl;
    renderModels();
    render(await call("get"));
  }
  function patch(extra = {}) { return { epoch: state.epoch, endpoint: settings.ollamaUrl, ...extra }; }
  async function probe(manual, grant) {
    if (busy || state?.active) return;
    busy = true; blocked = false; ready = false; abort(); controls();
    connectionHelp();
    const revision = probeRevision, endpoint = settings.ollamaUrl, epoch = state.epoch;
    const controller = new AbortController(); requestAbort = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      if (manual) {
        if (!await grant) throw new Error("接続先への権限が許可されませんでした。");
        render(await call("approve", { epoch, endpoint }));
      } else {
        const url = new URL(endpoint);
        if (!await api.permissions.contains({ origins: [url.protocol + "//" + url.hostname + "/*"], ...(firefox ? { data_collection: ["personalCommunications"] } : {}) })) throw new Error("接続権限がありません。「接続・再試行」を押してください。");
      }
      if (revision !== probeRevision || !visible) return;
      status("Ollamaへの接続とモデル一覧を確認しています…");
      const names = await globalThis.OshaberiNoteOllama.models(endpoint, controller.signal);
      if (revision !== probeRevision || epoch !== state.epoch || endpoint !== settings.ollamaUrl) return;
      modelNames = names;
      if (settings.ollamaModel && !names.includes(settings.ollamaModel)) { await platform.save({ ollamaModel: "" }); await sync(); }
      ready = true; renderModels();
      status(names.length ? "モデル一覧を取得しました。会話送信の可否は送信時に確認します。" : "モデルがありません。Ollama側でモデルを登録し、再試行してください。");
    } catch (error) { connectionHelp(error); status(controller.signal.aborted ? "接続確認を中止しました。Ollamaの起動と接続URLを確認してください。" : error.message); }
    finally { clearTimeout(timer); if (requestAbort === controller) requestAbort = undefined; busy = false; controls(); }
  }
  byId("connect-ollama").onclick = () => {
    if (!settings || busy) return;
    const url = new URL(core.normalizeOllamaUrl(settings.ollamaUrl));
    // 権限要求はクリックから同期的に開始し、利用者の操作との関連を維持する。
    const grant = api.permissions.request({ origins: [url.protocol + "//" + url.hostname + "/*"], ...(firefox ? { data_collection: ["personalCommunications"] } : {}) });
    void probe(true, grant);
  };
  byId("ollama-settings").onsubmit = async event => {
    event.preventDefault(); if (busy || !settings) return;
    let endpoint;
    try { endpoint = core.normalizeOllamaUrl(byId("ollama-url").value); }
    catch (error) { byId("ollama-settings-status").textContent = error.message; return; }
    if (endpoint === settings.ollamaUrl) { byId("ollama-settings-status").textContent = "接続先は変更されていません。"; return; }
    if (!confirm("接続先を変更すると、保存済みの会話と未送信入力を削除し、モデル選択を解除します。変更しますか？")) return;
    busy = true; abort(); controls();
    try {
      await platform.save({ ollamaUrl: endpoint });
      ready = false; blocked = false; modelNames = []; byId("chat-input").value = "";
      await sync();
      byId("ollama-settings-status").textContent = "接続先を保存し、会話を初期化しました。おしゃべり画面から接続してください。";
      status("接続先を変更しました。「接続・再試行」を押してください。");
    } catch (error) { blocked = true; byId("ollama-settings-status").textContent = error.message; }
    finally { busy = false; controls(); }
  };
  byId("chat-model").onchange = async () => {
    if (busy || !settings) return;
    const model = byId("chat-model").value;
    if (model && !modelNames.includes(model)) return;
    busy = true; abort(); controls();
    try { await platform.save({ ollamaModel: model }); await sync(); status(model ? `使用モデル：${model}` : "モデルを選択してください。"); }
    catch (error) { blocked = true; status(error.message); }
    finally { busy = false; controls(); }
  };
  byId("chat-form").onsubmit = async event => {
    event.preventDefault(); if (byId("chat-send").disabled) return;
    connectionHelp();
    busy = true; controls();
    const text = byId("chat-input").value, endpoint = settings.ollamaUrl, model = settings.ollamaModel;
    const controller = new AbortController(); requestAbort = controller;
    let id, epoch, lastSave = 0;
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      const started = await call("start", patch({ text, model, owner }));
      id = started.active.id; epoch = started.epoch; generatingId = id;
      controller.signal.throwIfAborted();
      if (!visible || settings.ollamaUrl !== endpoint || settings.ollamaModel !== model || state.epoch !== epoch || !settings.enabled) throw new Error("会話または接続設定が変更されました。");
      render(started); byId("chat-input").value = ""; busy = false; controls();
      status("応答を生成しています…");
      const response = await globalThis.OshaberiNoteOllama.chat(endpoint, model, started.messages, controller.signal, async answer => {
        controller.signal.throwIfAborted();
        if (state.epoch !== epoch || state.active?.id !== id) throw new Error("生成は中止されました。");
        state.turns.at(-1).assistant = answer; render(state);
        if (Date.now() - lastSave > 250) {
          lastSave = Date.now();
          await call("progress", { epoch, endpoint, id, owner, model, text: answer });
        }
      });
      controller.signal.throwIfAborted();
      render(await call("complete", { epoch, endpoint, id, owner, model, text: response }));
      status("応答が完了しました。");
    } catch (error) {
      controller.abort();
      connectionHelp(error);
      if (error.status === 403) ready = false;
      if (id) {
        try { render(await call("stop", { id, owner })); }
        catch { blocked = true; }
      }
      status(error.name === "AbortError" ? "生成を中止しました。未完了の会話は次回送信しません。" : `${error.message} 自動再送は行いません。`);
    } finally { clearTimeout(timer); if (requestAbort === controller) requestAbort = undefined; if (generatingId === id) generatingId = undefined; busy = false; controls(); }
  };
  byId("chat-stop").onclick = async () => {
    abort();
    try { render(await call("stop")); status("生成を中止しました。"); }
    catch (error) { status(error.message); }
  };
  byId("chat-new").onclick = async () => {
    if (busy) return;
    if (!confirm("現在の会話と未送信入力を削除し、新しい会話を始めますか？")) return;
    busy = true; abort(); controls();
    try { render(await call("reset")); byId("chat-input").value = ""; blocked = false; status("新しい会話を始めました。"); }
    catch (error) { status(error.message); }
    finally { busy = false; controls(); }
  };
  platform.subscribe(value => {
    const next = core.readSettings(value);
    if (!settings || next.ollamaUrl !== settings.ollamaUrl || next.ollamaModel !== settings.ollamaModel || !next.enabled) abort();
    if (settings && next.ollamaUrl !== settings.ollamaUrl) { ready = false; modelNames = []; byId("chat-input").value = ""; }
    settings = next; renderModels(); controls();
    byId("chat-endpoint").textContent = `接続先：${settings.ollamaUrl}`;
    if (document.activeElement !== byId("ollama-url")) byId("ollama-url").value = settings.ollamaUrl;
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.hasOwn(changes, chatKey)) return;
    try {
      const next = globalThis.OshaberiNoteChatState.read(changes[chatKey].newValue, settings.ollamaUrl);
      if (next.approvedUrl !== settings.ollamaUrl) { ready = false; abort(); }
      render(next);
    } catch { abort(); ready = false; blocked = true; status("会話の更新を確認できません。再読み込みして確認してください。"); controls(); }
  });
  api.permissions.onRemoved.addListener(() => { abort(); ready = false; status("接続権限が変更されました。「接続・再試行」で確認してください。"); controls(); });
  globalThis.OshaberiNoteChatUI = Object.freeze({ setVisible(value) {
    visible = value;
    if (!visible) {
      abort();
      if (generatingId) void call("stop", { owner, id: generatingId }).then(render).catch(error => status(error.message));
    }
  } });
  async function init() {
    try {
      connection = api.runtime.connect({ name: `oshaberi-chat:${owner}` });
      connection.onDisconnect.addListener(() => { abort(); ready = false; blocked = true; status("背景処理との接続が切れました。再読み込みして状態を確認してください。"); controls(); });
      await sync();
      if (visible && state.approvedUrl === settings.ollamaUrl && settings.enabled) await probe(false);
    } catch (error) { blocked = true; status(error.message); controls(); }
  }
  const heartbeat = setInterval(() => { try { connection?.postMessage({ type: "keep-alive" }); } catch { abort(); } }, 20000);
  addEventListener("pagehide", () => { clearInterval(heartbeat); abort(); connection?.disconnect(); });
  void init();
})();
