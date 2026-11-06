(() => {
  "use strict";
  const core = globalThis.OshaberiNote, platform = globalThis.OshaberiNotePlatform;
  const api = globalThis.browser ?? globalThis.chrome, byId = id => document.getElementById(id);
  const firefox = Boolean(api.runtime.getManifest?.().browser_specific_settings?.gecko);
  const owner = crypto.randomUUID(), chatKey = globalThis.OshaberiNoteChatState.key;
  let articleConsent = !firefox;
  let settings, state, connection, requestAbort, generatingId, ready = false, busy = false, blocked = false;
  let modelNames = [], probeRevision = 0, visible = !byId("panel-chat").hidden;
  let llmVisible = !byId("panel-llm").hidden;
  let promptDirty = false, promptBaseline = "";
  let actionStarting = false;
  let sendSequence = 0;
  const actionButtons = [];
  let selectedAction = "chat";
  const drafts = new Map(), articles = globalThis.OshaberiNoteArticles;
  let pendingArticleRequest, articleReference, articleSnapshot, localActive = false;
  let articleDraftContext;
  const currentArticleContext = () => ({ epoch: state?.epoch, segmentId: state?.activeArticleSegmentId ?? null });
  function articleTargetLabel() {
    const target = state?.articleSegments?.[state?.activeArticleSegmentId];
    const items = articleSnapshot?.endpoint === state?.endpoint && articleSnapshot?.conversation?.epoch === state?.epoch ? articleSnapshot.articles : [];
    return target ? `現在の送信対象：${items.find(item => item.articleId === target.articleId)?.title ?? target.articleId}（${target.articleId}）` : "対象記事が未選択です。過去の発言の記事タイトルから操作を選ぶか、記事ページから取り込んでください。";
  }
  const articleDialog = byId("chat-article-dialog");
  function discardPendingArticle() {
    const previous = pendingArticleRequest; pendingArticleRequest = undefined;
    if (previous?.requestToken) {
      globalThis.history?.replaceState?.(null, "", api.runtime.getURL("home.html"));
      void platform.article("cancel", { requestToken: previous.requestToken }).catch(error => { blocked = true; status(error.message); controls(); });
    }
  }
  function closeArticleDialog() { if (articleDialog.open) articleDialog.close(); articleReference = undefined; }
  function maybeSendArticle() {
    if (pendingArticleRequest && visible && selectedAction === "article" && ready && articleConsent && settings?.enabled && settings.ollamaModel && !state?.anyActive && !state?.active && !busy && !actionStarting && !blocked) byId("chat-form").requestSubmit();
  }
  function articleReferenceNode(node, turn) {
    const epoch = state.epoch, valid = () => selectedAction === "article" && state?.epoch === epoch && state.turns.some(item => item.user === turn.user && item.articleId === turn.articleId && item.articleAction === turn.articleAction);
    const button = document.createElement("button"), suffix = document.createElement("span");
    button.type = "button"; button.className = "chat-article-reference"; button.textContent = `[&${turn.articleTitle}]`;
    button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("title", turn.articleTitle);
    button.setAttribute("aria-label", `${turn.articleTitle}の記事操作を選択`);
    suffix.textContent = articles.actions[turn.articleAction].suffix;
    button.onclick = async () => {
      if (!valid()) return;
      try {
        const info = await platform.article("info", { epoch, articleId: turn.articleId });
        if (!valid()) return;
        articleReference = { ...info, epoch, valid };
        byId("chat-article-title").textContent = info.title; articleDialog.showModal(); controls();
      } catch (error) { status(error.message); }
    };
    node.append(button, suffix);
  }
  for (const action of Object.keys(articles.actions)) {
    byId(`chat-article-${action}`).onclick = () => {
      const reference = articleReference;
      if (!reference?.valid() || byId(`chat-article-${action}`).disabled) return;
      discardPendingArticle();
      articleDraftContext = undefined;
      pendingArticleRequest = { articleId: reference.articleId, articleAction: action, displayText: articles.display(reference, action) };
      byId("chat-input").value = pendingArticleRequest.displayText; closeArticleDialog();
      status("記事の依頼を用意しました。未接続の場合は「LLMの設定」で接続してください。"); maybeSendArticle();
    };
  }
  byId("chat-article-close").onclick = closeArticleDialog;
  articleDialog.addEventListener("close", () => { articleReference = undefined; });
  byId("chat-input").addEventListener("input", () => {
    if (pendingArticleRequest && byId("chat-input").value !== pendingArticleRequest.displayText) discardPendingArticle();
    if (selectedAction === "article") {
      if (!byId("chat-input").value) articleDraftContext = undefined;
      else articleDraftContext ??= currentArticleContext();
    }
  });
  let scrollTail;
  function scrollRange() {
    const container = byId("chat-messages");
    return Math.max(0, (container.scrollHeight || 0) - (container.clientHeight || 0));
  }
  function messagePositions() {
    const container = byId("chat-messages"), top = container.getBoundingClientRect().top + (container.clientTop || 0);
    const maximum = scrollRange();
    return [...container.querySelectorAll("article")].map(node => Math.max(0, Math.min(maximum, node.getBoundingClientRect().top - top + (container.scrollTop || 0))));
  }
  function updateScrollTail() {
    if (!visible) return;
    const container = byId("chat-messages"), rows = container.querySelectorAll("article");
    // 最後の短い発言も、先頭を会話欄の上端まで移動できるよう余白を確保する。
    if (scrollTail) {
      // 短い初回は余白自身がflex領域を伸ばすため、CSSの表示上限を基準にする。
      const viewport = Math.max(container.clientHeight || 0, Number.parseFloat(globalThis.getComputedStyle?.(container)?.maxHeight) || 0);
      const style = `height: ${Math.max(0, viewport - (rows[rows.length - 1]?.getBoundingClientRect().height || 0))}px`;
      if (scrollTail.getAttribute("style") !== style) scrollTail.setAttribute("style", style);
    }
  }
  function updateMessageNavigation() {
    if (!visible) return;
    const container = byId("chat-messages");
    const positions = messagePositions(), current = container.scrollTop || 0;
    byId("chat-previous-message").disabled = !positions.some(top => top < current - 2);
    byId("chat-next-message").disabled = !positions.some(top => top > current + 2);
    const index = Math.max(0, positions.findLastIndex(top => top <= current + 2));
    byId("chat-message-position").textContent = positions.length ? `${index + 1} / ${positions.length} 発言` : "発言なし";
  }
  function refreshMessageNavigation() { updateScrollTail(); updateMessageNavigation(); }
  function alignMessage(index) {
    if (!visible || scrollRange() <= 1) return;
    const target = messagePositions()[index];
    if (target === undefined) return;
    const container = byId("chat-messages");
    if (Math.abs(container.scrollTop - target) > 1) container.scrollTop = target;
    updateMessageNavigation();
  }
  function moveMessage(direction) {
    if (!visible) return;
    refreshMessageNavigation();
    const container = byId("chat-messages"), current = container.scrollTop || 0, positions = messagePositions();
    const target = direction < 0 ? positions.findLast(top => top < current - 2) : positions.find(top => top > current + 2);
    if (target === undefined) return;
    container.scrollTop = target; updateMessageNavigation();
  }
  byId("chat-previous-message").onclick = () => moveMessage(-1);
  byId("chat-next-message").onclick = () => moveMessage(1);
  byId("chat-messages").addEventListener("scroll", updateMessageNavigation);
  addEventListener("resize", refreshMessageNavigation);
  const status = text => { byId("chat-status").textContent = text; };
  const connectionStatus = text => { byId("llm-connection-status").textContent = text; };
  const tagUI = globalThis.OshaberiNoteChatTags.create({ document, platform, getSettings: () => settings,
    onSaved(value) { settings = core.readSettings(value); } });
  function connectionHelp(error) {
    const origin = api.runtime.getURL("").replace(/\/$/, "");
    const show = error?.status === 403 && /^(chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin);
    byId("ollama-origin-help").hidden = !show;
    if (show) byId("ollama-start-help").open = true;
    if (/^(chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin)) {
      byId("ollama-extension-origin").textContent = origin;
      byId("ollama-origin-command").value = `$env:OLLAMA_ORIGINS = (@($env:OLLAMA_ORIGINS -split ',' | Where-Object { $_ }) + @('${origin}') | Select-Object -Unique) -join ','\n$env:OLLAMA_CONTEXT_LENGTH = '16384'\nollama serve`;
    }
  }
  function controls() {
    const active = Boolean(state?.active);
    const working = busy || actionStarting;
    byId("connect-ollama").disabled = working || !settings?.enabled || active || blocked;
    byId("chat-model").disabled = working || !ready || blocked;
    byId("chat-input").disabled = working || !settings?.enabled || blocked;
    byId("chat-send").disabled = working || active || state?.anyActive || (selectedAction === "article" && !articleConsent) || !ready || !settings?.ollamaModel || !settings?.enabled || blocked;
    byId("chat-stop").disabled = !active;
    byId("chat-new").disabled = working || !settings;
    byId("save-ollama-url").disabled = working || !settings;
    byId("system-prompt").disabled = working || !settings;
    byId("save-system-prompt").disabled = working || !settings;
    for (const button of actionButtons) button.disabled = working || !settings || !state || blocked;
    for (const action of Object.keys(articles.actions)) byId(`chat-article-${action}`).disabled = working || !settings?.enabled || Boolean(state?.anyActive) || blocked;
    tagUI.refresh();
  }
  function abort() { requestAbort?.abort(); requestAbort = undefined; probeRevision++; }
  async function call(operation, patch = {}) {
    let result;
    try { result = await api.runtime.sendMessage({ type: "chat-operation", operation, patch: { actionId: selectedAction, ...patch } }); }
    catch { blocked = true; controls(); throw new Error("保存結果を確認できません。ページを再読み込みして状態を確認してください。自動再送は行いません。"); }
    if (!result?.ok) { if (!["INVALID_INPUT", "STALE_CHAT", "STALE_ARTICLE_CONTEXT", "CHAT_BUSY"].includes(result?.code)) blocked = true; controls(); throw Object.assign(new Error(result?.error || "会話の処理結果を確認できません。"), { code: result?.code }); }
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
    const sameConversation = state?.actionId === next.actionId && state?.epoch === next.epoch;
    const accepted = sameConversation && next.active && next.active.id !== state.active?.id;
    const completed = sameConversation && state.active && !next.active && next.turns.at(-1)?.status === "complete";
    if (state && (state.actionId !== next.actionId || state.epoch !== next.epoch)) {
      abort(); generatingId = undefined; tagUI.close(); closeArticleDialog();
      if (state.actionId !== next.actionId) {
        drafts.set(state.actionId, { epoch: state.epoch, text: byId("chat-input").value, articleRequest: pendingArticleRequest, articleDraftContext });
        const draft = drafts.get(next.actionId);
        byId("chat-input").value = draft?.epoch === next.epoch ? draft.text : "";
        pendingArticleRequest = draft?.epoch === next.epoch ? draft.articleRequest : undefined;
        articleDraftContext = draft?.epoch === next.epoch ? draft.articleDraftContext : undefined;
      } else { drafts.delete(next.actionId); byId("chat-input").value = ""; pendingArticleRequest = undefined; articleDraftContext = undefined; }
    }
    if (generatingId && next.active?.id !== generatingId) { abort(); generatingId = undefined; }
    state = next; selectedAction = state.actionId;
    for (const button of actionButtons) {
      const selected = button.getAttribute("data-chat-action") === selectedAction;
      button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1;
    }
    byId("chat-messages").setAttribute("aria-labelledby", `chat-tab-${selectedAction}`);
    byId("chat-input-help").textContent = selectedAction === "article" ? "最大200,000文字。閲覧できる記事本文だけを使います。記事と今回の依頼文がモデルのコンテキストに収まらない場合はエラーにし、本文を自動で切り捨てません。" : "最大200,000文字。記事本文も貼り付けられます。長文や過去の会話は、Ollamaのコンテキスト長によって一部が参照されない場合があります。";
    const action = globalThis.OshaberiNoteChatActions.find(state.actionId);
    byId("chat-heading").textContent = action ? `おしゃべり（${action.title} v${action.version}）` : "おしゃべり";
    byId("chat-history-info").textContent = `履歴は各会話タブで直近10往復・最大2MiBを保存し、古い分から自動で整理します。${state.droppedTurns ? ` これまでに${state.droppedTurns}往復を保存から外しました。` : ""}${state.contextTrimmedTurns ? ` 直近の送信では、保存履歴のうち古い${state.contextTrimmedTurns}往復を送信対象から外しました。` : ""}`;
    const container = byId("chat-messages"), previousTop = container.scrollTop || 0;
    container.replaceChildren();
    for (const turn of state.turns) {
      for (const [label, content] of [["あなた", turn.user], [turn.status === "complete" ? "AI" : turn.status === "pending" ? "AI（生成中・未完了）" : "AI（中断・次回送信の対象外）", turn.assistant]]) {
        const article = document.createElement("article"), heading = document.createElement("h3"), text = document.createElement("div");
        text.className = "chat-message-body"; text.setAttribute("data-chat-body", "");
        heading.textContent = label;
        const header = document.createElement("div"), copy = document.createElement("button"), feedback = document.createElement("span");
        header.className = "chat-message-heading";
        copy.type = "button"; copy.className = "secondary chat-copy"; copy.textContent = "コピー";
        copy.setAttribute("aria-label", label === "あなた" ? "自分の発言をコピー" : "AIの回答をコピー");
        copy.disabled = !content || label === "AI（生成中・未完了）";
        feedback.className = "chat-copy-status"; feedback.setAttribute("role", "status");
        copy.onclick = async () => {
          if (copy.disabled) return;
          copy.disabled = true; feedback.textContent = "";
          try {
            await navigator.clipboard.writeText(content);
            if (copy.isConnected) feedback.textContent = "コピーしました。";
          } catch {
            if (copy.isConnected) feedback.textContent = "コピーできませんでした。本文を選択してコピーしてください。";
          } finally { copy.disabled = false; }
        };
        header.append(heading, copy, feedback);
        if (label === "あなた" && turn.articleId && articles.actions[turn.articleAction]) articleReferenceNode(text, turn);
        else if (label === "AI" && content) {
          const epoch = state.epoch, user = turn.user;
          tagUI.render(text, content, () => state?.epoch === epoch && state.turns.some(item => item.status === "complete" && item.user === user && item.assistant === content));
        } else text.textContent = content || "（応答なし）";
        article.append(header, text); container.append(article);
      }
    }
    if (!state.turns.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "新しい会話です。メッセージを入力してください。"; container.append(empty); }
    scrollTail = undefined;
    // 初回も含め、短いAI発言の先頭を上端へ合わせられる余白を設ける。
    if (state.turns.length) { scrollTail = document.createElement("div"); scrollTail.className = "chat-scroll-tail"; scrollTail.setAttribute("aria-hidden", "true"); container.append(scrollTail); }
    refreshMessageNavigation();
    if (scrollRange() > 1 && Math.abs(container.scrollTop - previousTop) > 1) container.scrollTop = previousTop;
    if (accepted) alignMessage(state.turns.length * 2 - 2);
    else if (completed) alignMessage(state.turns.length * 2 - 1);
    updateMessageNavigation();
    controls();
  }
  async function sync(restoreSelection = false) {
    settings = await platform.getState();
    byId("chat-endpoint").textContent = `接続先：${settings.ollamaUrl}`;
    if (document.activeElement !== byId("ollama-url")) byId("ollama-url").value = settings.ollamaUrl;
    if (!promptDirty) { byId("system-prompt").value = settings.ollamaSystemPrompt; promptBaseline = settings.ollamaSystemPrompt; }
    renderModels();
    render(await call(restoreSelection ? "restore" : "get"));
  }
  function patch(extra = {}) { return { epoch: state.epoch, endpoint: settings.ollamaUrl, ...(selectedAction === "article" ? { articleSegmentId: state.activeArticleSegmentId } : {}), ...extra }; }
  const tabs = [{ id: "chat", title: "通常の会話" }, ...globalThis.OshaberiNoteChatActions.definitions];
  for (const action of tabs) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = action.title; button.disabled = true;
    button.id = `chat-tab-${action.id}`; button.setAttribute("id", button.id);
    button.setAttribute("data-chat-action", action.id); button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "chat-messages"); button.setAttribute("aria-selected", String(action.id === selectedAction));
    button.tabIndex = action.id === selectedAction ? 0 : -1;
    button.onclick = async () => {
      if (button.disabled || actionStarting || !visible || !settings || !state || selectedAction === action.id) return;
      actionStarting = true; busy = true; sendSequence++; abort(); controls();
      let send = false;
      try {
        const next = await call("select", { actionId: action.id, owner });
        render(next);
        if (next.initialMessage) { byId("chat-input").value = next.initialMessage; send = visible && ready && settings.enabled && Boolean(settings.ollamaModel); }
        status(next.turns.length ? "会話を復元しました。" : "新しい会話です。メッセージを入力してください。");
      } catch (error) { status(error.message); }
      finally { actionStarting = false; busy = false; controls(); }
      if (send) byId("chat-form").requestSubmit();
    };
    button.addEventListener("keydown", event => {
      const index = actionButtons.indexOf(button);
      const target = event.key === "Home" ? 0 : event.key === "End" ? actionButtons.length - 1 :
        event.key === "ArrowRight" ? (index + 1) % actionButtons.length : event.key === "ArrowLeft" ? (index + actionButtons.length - 1) % actionButtons.length : -1;
      if (target < 0 || actionButtons[target].disabled) return;
      event.preventDefault(); actionButtons[target].focus(); void actionButtons[target].onclick();
    });
    byId("chat-actions").append(button); actionButtons.push(button);
  }
  async function probe(manual, grant) {
    if (busy || (state?.active && !pendingArticleRequest)) return;
    busy = true; blocked = false; ready = false; abort(); controls();
    connectionHelp();
    const revision = probeRevision, endpoint = settings.ollamaUrl, epoch = state.epoch, actionId = selectedAction;
    const controller = new AbortController(); requestAbort = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      if (manual) {
        if (!await grant) throw new Error("接続先への権限が許可されませんでした。");
        if (firefox && actionId === "article") articleConsent = true;
        render(await call("approve", { epoch, endpoint, actionId }));
      } else {
        const url = new URL(endpoint);
        if (!await api.permissions.contains({ origins: [url.protocol + "//" + url.hostname + "/*"], ...(firefox ? { data_collection: ["personalCommunications", ...(selectedAction === "article" ? ["websiteContent"] : [])] } : {}) })) throw new Error("接続権限がありません。「接続・再試行」を押してください。");
      }
      if (revision !== probeRevision || (!visible && !llmVisible)) return;
      connectionStatus("Ollamaへの接続とモデル一覧を確認しています…");
      const names = await globalThis.OshaberiNoteOllama.models(endpoint, controller.signal);
      if (revision !== probeRevision || epoch !== state.epoch || endpoint !== settings.ollamaUrl) return;
      modelNames = names;
      if (settings.ollamaModel && !names.includes(settings.ollamaModel)) { await platform.save({ ollamaModel: "" }); await sync(); }
      ready = true; renderModels();
      connectionStatus(names.length ? "モデル一覧を取得しました。会話送信の可否は送信時に確認します。" : "モデルがありません。Ollama側でモデルを登録し、再試行してください。");
      status(names.length && settings.ollamaModel ? "会話できます。" : "「LLMの設定」でモデルを選択してください。");
    } catch (error) {
      connectionHelp(error);
      connectionStatus(controller.signal.aborted ? "接続確認を中止しました。Ollamaの起動と接続URLを確認してください。" : error.message);
      status("接続を確認できません。「LLMの設定」で確認してください。");
    }
    finally { clearTimeout(timer); if (requestAbort === controller) requestAbort = undefined; busy = false; controls(); maybeSendArticle(); }
  }
  byId("connect-ollama").onclick = () => {
    if (!settings || busy) return;
    const url = new URL(core.normalizeOllamaUrl(settings.ollamaUrl));
    // 権限要求はクリックから同期的に開始し、利用者の操作との関連を維持する。
    const grant = api.permissions.request({ origins: [url.protocol + "//" + url.hostname + "/*"], ...(firefox ? { data_collection: ["personalCommunications", ...(selectedAction === "article" ? ["websiteContent"] : [])] } : {}) });
    void probe(true, grant);
  };
  byId("ollama-settings").onsubmit = async event => {
    event.preventDefault(); if (busy || !settings) return;
    let endpoint, expectedToken;
    try { endpoint = core.normalizeOllamaUrl(byId("ollama-url").value); expectedToken = core.settingsToken(settings); }
    catch (error) { byId("ollama-settings-status").textContent = error.message; return; }
    if (endpoint === settings.ollamaUrl) { byId("ollama-settings-status").textContent = "接続先は変更されていません。"; return; }
    if (!confirm("接続先を変更すると、保存済みの会話と未送信入力を削除し、モデル選択・システムプロンプトを初期化します。変更しますか？")) return;
    busy = true; abort(); controls();
    try {
      await platform.saveLLM({ ollamaUrl: endpoint }, expectedToken);
      ready = false; blocked = false; modelNames = []; byId("chat-input").value = "";
      promptDirty = false;
      await sync();
      byId("ollama-settings-status").textContent = "接続先を保存し、会話を初期化しました。この画面の「接続・再試行」から接続してください。";
      connectionStatus("接続先を変更しました。「接続・再試行」を押してください。");
      status("「LLMの設定」で接続し、モデルを選択してください。");
    } catch (error) { blocked = true; byId("ollama-settings-status").textContent = error.message; }
    finally { busy = false; controls(); }
  };
  byId("system-prompt").addEventListener("input", () => {
    if (!promptDirty) promptBaseline = settings?.ollamaSystemPrompt ?? "";
    promptDirty = true; byId("system-prompt-status").textContent = "未保存の変更があります。";
  });
  byId("system-prompt-settings").onsubmit = async event => {
    event.preventDefault(); if (busy || !settings) return;
    let value, expectedToken;
    try { value = core.validateSystemPrompt(byId("system-prompt").value); expectedToken = core.settingsToken(settings); }
    catch (error) { byId("system-prompt-status").textContent = error.message; return; }
    if (value === settings.ollamaSystemPrompt) { promptDirty = false; promptBaseline = value; byId("system-prompt-status").textContent = "システムプロンプトは変更されていません。"; return; }
    if (promptDirty && promptBaseline !== settings.ollamaSystemPrompt) { byId("system-prompt-status").textContent = "別の画面でシステムプロンプトが変更されました。入力を控えたうえで再読み込みし、最新の設定を確認してください。"; return; }
    if (!confirm("システムプロンプトを変更し、「通常の会話」の履歴と未送信入力を削除します。保存しますか？")) return;
    busy = true; if (selectedAction === "chat") abort(); controls();
    try {
      await platform.saveLLM({ ollamaSystemPrompt: value }, expectedToken);
      promptDirty = false; blocked = false; drafts.delete("chat"); if (selectedAction === "chat") byId("chat-input").value = "";
      await sync();
      byId("system-prompt-status").textContent = "システムプロンプトを保存し、通常の会話を初期化しました。";
      status("通常の会話のシステムプロンプトを変更しました。");
    } catch (error) { blocked = true; byId("system-prompt-status").textContent = error.message; }
    finally { busy = false; controls(); }
  };
  byId("chat-model").onchange = async () => {
    if (busy || !settings) return;
    const model = byId("chat-model").value;
    if (model && !modelNames.includes(model)) return;
    busy = true; abort(); controls();
    try { await platform.save({ ollamaModel: model }); await sync(); connectionStatus(model ? `使用モデル：${model}` : "モデルを選択してください。"); status(model ? "会話できます。" : "「LLMの設定」でモデルを選択してください。"); }
    catch (error) { blocked = true; connectionStatus(error.message); status("モデルを保存できません。「LLMの設定」で確認してください。"); }
    finally { busy = false; controls(); maybeSendArticle(); }
  };
  byId("chat-input").addEventListener("keydown", event => {
    if (event.key !== "Enter" || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing || event.keyCode === 229 || event.repeat) return;
    if (byId("chat-input").disabled || byId("chat-send").disabled) return;
    event.preventDefault();
    byId("chat-form").requestSubmit();
  });
  byId("chat-form").onsubmit = async event => {
    event.preventDefault(); if (byId("chat-send").disabled) return;
    if (selectedAction === "article" && !pendingArticleRequest) {
      const current = currentArticleContext();
      if (articleDraftContext && (articleDraftContext.epoch !== current.epoch || articleDraftContext.segmentId !== current.segmentId)) {
        if (!confirm(`${articleTargetLabel()}\n入力中に対象の会話区間が変更されました。この文章を現在の対象へ送信しますか？`)) return;
      }
      articleDraftContext = current;
    }
    const sequence = ++sendSequence;
    connectionHelp();
    busy = true; controls();
    const text = byId("chat-input").value, endpoint = settings.ollamaUrl, model = settings.ollamaModel, actionId = selectedAction;
    const articleRequest = pendingArticleRequest;
    const controller = new AbortController(); requestAbort = controller;
    let id, epoch, lastSave = 0, waitForArticle = false;
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      const started = await call("start", patch({ text, model, owner, ...(articleRequest ? { articleId: articleRequest.articleId, articleAction: articleRequest.articleAction, requestToken: articleRequest.requestToken } : {}) }));
      id = started.active.id; epoch = started.epoch; generatingId = id;
      controller.signal.throwIfAborted();
      if (sequence !== sendSequence || !visible || settings.ollamaUrl !== endpoint || settings.ollamaModel !== model || state.epoch !== epoch || !settings.enabled) throw new Error("会話または接続設定が変更されました。");
      if (pendingArticleRequest === articleRequest) pendingArticleRequest = undefined;
      if (articleRequest?.requestToken) globalThis.history?.replaceState?.(null, "", api.runtime.getURL("home.html"));
      articleDraftContext = undefined;
      render(started); byId("chat-input").value = ""; busy = false; controls();
      if (visible && !byId("chat-input").disabled) byId("chat-input").focus({ preventScroll: true });
      status("応答を生成しています…");
      const response = await globalThis.OshaberiNoteOllama.chat(endpoint, model, started.messages, controller.signal, async answer => {
        controller.signal.throwIfAborted();
        if (state.epoch !== epoch || state.active?.id !== id) throw new Error("生成は中止されました。");
        state.turns.at(-1).assistant = answer;
        const container = byId("chat-messages");
        const rows = container.querySelectorAll("article"), paragraph = rows[rows.length - 1]?.querySelector("[data-chat-body]");
        // 長い記事本文を受信チャンクごとに作り直さず、末尾のAI発言だけ更新する。
        if (paragraph) paragraph.textContent = answer || "（応答なし）";
        else render(state);
        refreshMessageNavigation();
        updateMessageNavigation();
        if (Date.now() - lastSave > 250) {
          lastSave = Date.now();
          await call("progress", { actionId, epoch, endpoint, id, owner, model, text: answer });
        }
      }, { truncate: actionId !== "article" });
      controller.signal.throwIfAborted();
      const completed = await call("complete", { actionId, epoch, endpoint, id, owner, model, text: response });
      if (sequence === sendSequence) { render(completed); status("応答が完了しました。"); }
    } catch (error) {
      controller.abort();
      if (error.code === "INVALID_INPUT" && articleRequest?.requestToken && pendingArticleRequest === articleRequest) discardPendingArticle();
      if (sequence === sendSequence) connectionHelp(error);
      if (sequence === sendSequence && error.status === 403) { ready = false; connectionStatus(error.message); }
      if (id) {
        try { const stopped = await call("stop", { actionId, id, owner }); if (sequence === sendSequence) render(stopped); }
        catch { blocked = true; }
      }
      if (error.code === "STALE_ARTICLE_CONTEXT") { await sync(); status(`${error.message} 入力は保持しています。自動再送は行いません。`); }
      else if (error.code === "CHAT_BUSY") { waitForArticle = true; await sync(); status("別の応答が完了するまで記事の依頼を待機します。"); }
      else if (sequence === sendSequence) status(error.name === "AbortError" ? "生成を中止しました。未完了の会話は次回送信しません。" : `${error.message}${error.status === 403 ? " 詳細は「LLMの設定」で確認してください。" : ""} 自動再送は行いません。`);
    } finally { clearTimeout(timer); if (requestAbort === controller) requestAbort = undefined; if (generatingId === id) generatingId = undefined; if (sequence === sendSequence) busy = false; controls(); if (waitForArticle) Promise.resolve().then(maybeSendArticle); }
  };
  byId("chat-stop").onclick = async () => {
    abort();
    try { render(await call("stop")); status("生成を中止しました。"); }
    catch (error) { status(error.message); }
  };
  byId("chat-new").onclick = async () => {
    if (busy) return;
    if (!confirm("選択中のタブの会話と未送信入力を削除し、新しい会話を始めますか？")) return;
    busy = true; sendSequence++; abort(); controls();
    try { render(await call("reset")); byId("chat-input").value = ""; blocked = false; status("新しい会話を始めました。"); }
    catch (error) { status(error.message); }
    finally { busy = false; controls(); }
  };
  platform.subscribe(value => {
    const next = core.readSettings(value);
    if (!settings || next.ollamaUrl !== settings.ollamaUrl || next.ollamaModel !== settings.ollamaModel || (selectedAction === "chat" && next.ollamaSystemPrompt !== settings.ollamaSystemPrompt) || !next.enabled) abort();
    if (settings && next.ollamaUrl !== settings.ollamaUrl) { ready = false; modelNames = []; drafts.clear(); pendingArticleRequest = undefined; byId("chat-input").value = ""; promptDirty = false; byId("system-prompt-status").textContent = ""; }
    settings = next; renderModels(); controls();
    byId("chat-endpoint").textContent = `接続先：${settings.ollamaUrl}`;
    if (document.activeElement !== byId("ollama-url")) byId("ollama-url").value = settings.ollamaUrl;
    if (!promptDirty) { byId("system-prompt").value = settings.ollamaSystemPrompt; promptBaseline = settings.ollamaSystemPrompt; }
  });
  api.storage.onChanged.addListener((changes, area) => {
    const articleChanged = area === "session" && Object.hasOwn(changes, articles.key);
    if (!articleChanged && (area !== "local" || !Object.hasOwn(changes, chatKey))) return;
    try {
      let next;
      if (articleChanged) {
        articleSnapshot = changes[articles.key].newValue;
        if (selectedAction === "article" && articleSnapshot?.endpoint === settings.ollamaUrl && articleSnapshot.conversation) {
          next = globalThis.OshaberiNoteChatState.read(articleSnapshot.conversation, settings.ollamaUrl, "article");
          if (state?.endpoint === next.endpoint) next.approvedUrl = state.approvedUrl;
        }
      } else {
        const store = globalThis.OshaberiNoteChatState.readStore(changes[chatKey].newValue, settings.ollamaUrl);
        localActive = Object.values(store.conversations).some(item => Boolean(item.active));
        if (selectedAction === "article") {
          if (articleSnapshot?.endpoint === settings.ollamaUrl && articleSnapshot.conversation) next = globalThis.OshaberiNoteChatState.read(articleSnapshot.conversation, settings.ollamaUrl, "article");
          else if (state?.endpoint === settings.ollamaUrl) next = { ...state };
          if (next) next.approvedUrl = store.approvedUrl;
        } else next = globalThis.OshaberiNoteChatState.read(changes[chatKey].newValue, settings.ollamaUrl, selectedAction);
      }
      const anyActive = localActive || Boolean(articleSnapshot?.conversation?.active);
      if (next) {
        next.anyActive = anyActive;
        if (next.approvedUrl !== settings.ollamaUrl) { ready = false; abort(); }
        render(next);
      } else if (state) { state.anyActive = anyActive; controls(); }
      Promise.resolve().then(maybeSendArticle);
    } catch { abort(); ready = false; blocked = true; status("会話の更新を確認できません。再読み込みして確認してください。"); controls(); }
  });
  api.permissions.onRemoved.addListener(() => { if (firefox) articleConsent = false; abort(); ready = false; connectionStatus("接続権限が変更されました。「接続・再試行」で確認してください。"); status("接続権限が変更されました。「LLMの設定」で確認してください。"); controls(); });
  globalThis.OshaberiNoteChatUI = Object.freeze({ async settingsImported() {
    promptDirty = false;
    await sync();
    byId("system-prompt-status").textContent = "";
  }, setVisible(value, llm = false) {
    const leavingChat = visible && !value;
    const leavingBoth = (visible || llmVisible) && !value && !llm;
    visible = value; llmVisible = llm;
    if (visible) setTimeout(refreshMessageNavigation, 0);
    if (leavingChat || leavingBoth) {
      tagUI.close(); closeArticleDialog();
      abort();
      if (generatingId) void call("stop", { owner, id: generatingId }).then(render).catch(error => status(error.message));
    }
  } });
  async function init() {
    try {
      connectionHelp();
      // 旧版の画面別選択は共有区間へ移行したため使用しない。
      try { globalThis.sessionStorage?.removeItem("oshaberiNote.articleContext.v1"); } catch { /* 旧選択が残っても参照しない。 */ }
      connection = api.runtime.connect({ name: `oshaberi-chat:${owner}` });
      connection.onDisconnect.addListener(() => { abort(); ready = false; blocked = true; status("背景処理との接続が切れました。再読み込みして状態を確認してください。"); controls(); });
      if (firefox) articleConsent = await api.permissions.contains({ data_collection: ["websiteContent"] });
      const local = (await api.storage.local.get(chatKey))[chatKey];
      localActive = Boolean(local?.active) || Object.values(local?.conversations ?? {}).some(item => Boolean(item.active));
      if (api.storage.session) articleSnapshot = (await api.storage.session.get(articles.key))[articles.key];
      await sync(true);
      const incoming = /^#article-request=([a-zA-Z0-9-]{36})$/.exec(globalThis.location.hash);
      if (incoming) {
        render(await call("select", { actionId: "article", owner }));
        try { pendingArticleRequest = await platform.article("request", { requestToken: incoming[1] }); articleDraftContext = undefined; byId("chat-input").value = pendingArticleRequest.displayText; }
        catch (error) { status(error.message); }
      }
      if ((visible || llmVisible) && state.approvedUrl === settings.ollamaUrl && settings.enabled) await probe(false);
      maybeSendArticle();
    } catch (error) { blocked = true; status(error.message); controls(); }
  }
  const heartbeat = setInterval(() => { try { connection?.postMessage({ type: "keep-alive" }); } catch { abort(); } }, 20000);
  addEventListener("pagehide", () => { clearInterval(heartbeat); abort(); connection?.disconnect(); });
  void init();
})();
