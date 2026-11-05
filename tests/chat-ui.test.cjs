const { test } = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const backend = require('./helpers/chat.cjs'), { source } = backend;
const { documentFromHtml } = require('./helpers/dom.cjs');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
async function fixture(t, options = {}) {
  const f = backend(), c = f.context, requests = [], grants = [], events = new Map(), confirmations = [];
  await f.save({ ollamaModel: 'local' });
  const document = documentFromHtml(source('home.html'));
  const timers = new Set();
  Object.assign(c, { document, location: { hash: options.hash ?? '', assign() {} }, AbortController, AbortSignal, TextDecoder,
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: text => { confirmations.push(text); return options.confirm !== false; },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
    setInterval: () => 1, clearInterval() {}, addEventListener: (type, fn) => events.set(type, fn),
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/api/tags')) return new Response('{"models":[{"name":"local"}]}');
      if (options.postStatus) return new Response('', { status: options.postStatus });
      if (options.stream) return options.stream(init);
      return new Response(JSON.stringify({ message: { role: 'assistant', content: options.reply ?? '<script>alert(1)</script>こんにちは' }, done: true }) + '\n');
    }
  });
  c.chrome.permissions.request = async permission => { grants.push(structuredClone(permission)); return options.grant !== false; };
  c.chrome.runtime.sendMessage = async message => {
    try {
      if (message.operation === 'progress' && message.patch.actionId === 'chat') await options.progressGate;
      if (message.type === 'tag-operation') { await options.tagGate; if (options.tagError) throw Object.assign(new Error('登録結果を確認できません'), { code: 'UNCONFIRMED' }); }
      return { ok: true, settings: await f.send(message) };
    }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  };
  c.chrome.runtime.connect = ({ name }) => {
    const disconnect = f.connect(name.slice('oshaberi-chat:'.length));
    return { onDisconnect: { addListener() {} }, postMessage() {}, disconnect };
  };
  for (const file of ['src/home.js', 'src/ollama.js', 'src/chat-tags.js', 'src/chat-ui.js']) vm.runInContext(source(file), c, { filename: file });
  t.after(() => { for (const timer of timers) clearTimeout(timer); events.get('pagehide')?.(); });
  await flush();
  return { ...f, c, document, nodes: document.nodes, requests, grants, confirmations, events };
}
test('ホームはおしゃべり初期表示、歯車の#settingsは設定を表示し、初回に接続しない', async t => {
  for (const hash of ['', '#settings']) {
    const f = await fixture(t, { hash });
    assert.equal(f.nodes.get(hash ? 'panel-settings' : 'panel-chat').hidden, false);
    assert.equal(f.requests.length, 0); assert.equal(f.grants.length, 0);
    assert.equal(f.nodes.has('operation-mode'), false);
    assert.equal(f.nodes.has('note-logo-browser-back'), false);
  }
});
test('接続・モデル・送信を通して実モジュールで会話し、HTMLを文字として表示する', async t => {
  const f = await fixture(t), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.deepEqual(f.grants[0].origins, ['http://127.0.0.1/*']);
  assert.equal(n.get('chat-send').disabled, false);
  n.get('chat-input').value = 'hello\nworld'; n.get('chat-form').fire('submit'); await flush();
  assert.match(n.get('chat-status').textContent, /完了/);
  assert.match(n.get('chat-messages').textContent, /<script>alert\(1\)<\/script>こんにちは/);
  assert.equal(n.get('chat-messages').querySelector('script'), null);
  assert.equal((await f.chat('get')).turns[0].status, 'complete');
  assert.equal(n.get('chat-input').value, '');
  assert.equal(f.document.activeElement, n.get('chat-input'));
  assert.deepEqual(JSON.parse(f.requests[1].init.body).messages, [{ role: 'user', content: 'hello\nworld' }]);
});
test('権限拒否時にはAPIへ接続せず、既存の設定・お気に入りを利用できる', async t => {
  const f = await fixture(t, { grant: false }), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  assert.equal(f.requests.length, 0); assert.equal(n.get('chat-send').disabled, true);
  n.get('nav-tags').onclick(); assert.equal(n.get('panel-tags').hidden, false); assert.equal(n.get('add-tag').disabled, false);
});

test('タグタブの初回送信と通常会話の復元で、プロンプトと履歴を分離する', async t => {
  const f = await fixture(t, { reply: '[#読書]' }), n = f.nodes;
  const action = n.get('chat-actions').children[1];
  assert.equal(action.textContent, 'タグの提案'); assert.equal(action.disabled, false);
  await f.save({ ollamaSystemPrompt: '通常の調査条件' }); await flush();
  n.get('connect-ollama').onclick(); await flush();
  n.get('chat-input').value = '以前の質問'; n.get('chat-form').fire('submit'); await flush();
  n.get('chat-input').value = '以前の下書き';
  await action.onclick(); await flush();
  assert.equal(f.confirmations.length, 0);
  assert.match(n.get('chat-heading').textContent, /タグの提案 v1\.2/);
  const posts = () => f.requests.filter(item => item.url.endsWith('/api/chat')).map(item => JSON.parse(item.init.body));
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].messages.length, 2);
  assert.match(posts()[1].messages[0].content, /^# タグ提案アシスタント/);
  assert.equal(posts()[1].messages[1].content, 'noteで面白そうなタグを提案してください。');
  assert.doesNotMatch(n.get('chat-messages').textContent, /以前の質問|タグ提案アシスタント/);
  assert.equal(n.get('chat-input').value, ''); assert.equal(f.document.activeElement, n.get('chat-input'));
  await f.send({ type: 'tag-operation', patch: { type: 'ADD_TAG', groupId: 'group4', tag: '読書' } }); await flush();
  n.get('chat-input').value = '今度は技術で'; n.get('chat-form').fire('submit'); await flush();
  assert.ok(posts()[2].messages[0].content.includes('["読書"]'));
  assert.equal(posts()[2].messages.filter(item => item.role === 'system').length, 1);
  assert.equal((await f.settings()).ollamaSystemPrompt, '通常の調査条件');
  await n.get('chat-actions').children[0].onclick(); await flush();
  assert.equal(n.get('chat-input').value, '以前の下書き');
  assert.match(n.get('chat-messages').textContent, /以前の質問/);
  assert.equal(n.get('chat-actions').children[0].getAttribute('aria-selected'), 'true');
  n.get('chat-input').value = '通常へ'; n.get('chat-form').fire('submit'); await flush();
  assert.deepEqual(posts()[3].messages, [{ role: 'system', content: '通常の調査条件' }, { role: 'user', content: '以前の質問' }, { role: 'assistant', content: '[#読書]' }, { role: 'user', content: '通常へ' }]);
  await action.onclick(); await flush();
  assert.equal(posts().length, 4); assert.match(n.get('chat-messages').textContent, /今度は技術で/);

});

test('未接続でもタブを切り替えて下書きを保持し、勝手に送信しない', async t => {
  const f = await fixture(t), n = f.nodes, tabs = n.get('chat-actions').children;
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  n.get('chat-input').value = '通常の下書き';
  await tabs[1].onclick(); await flush();
  assert.equal(n.get('chat-input').value, 'noteで面白そうなタグを提案してください。');
  n.get('chat-input').value = 'タグの下書き';
  await tabs[0].onclick(); await flush(); assert.equal(n.get('chat-input').value, '通常の下書き');
  await tabs[1].onclick(); await flush(); assert.equal(n.get('chat-input').value, 'タグの下書き');
  assert.equal(f.requests.length, 0); assert.equal(f.confirmations.length, 0);
});

test('タグ提案の初回POSTにも全4グループの最新タグを重複除去して付与する', async t => {
  const f = await fixture(t), n = f.nodes;
  for (const [groupId, tag] of [['group1', 'ComfyUI'], ['group2', 'AIマンガ'], ['group3', 'ショートショート'], ['group4', 'ComfyUI']])
    await f.send({ type: 'tag-operation', patch: { type: 'ADD_TAG', groupId, tag } });
  await flush(); n.get('connect-ollama').onclick(); await flush();
  await n.get('chat-actions').children[1].onclick(); await flush();
  const posts = f.requests.filter(item => item.url.endsWith('/api/chat'));
  assert.equal(posts.length, 1);
  const { messages } = JSON.parse(posts[0].init.body);
  assert.deepEqual(messages.map(item => item.role), ['system', 'user']);
  const data = messages[0].content.split('現在登録されているタグ：\\\n')[1].split('\n')[0];
  assert.deepEqual(JSON.parse(data), ['ComfyUI', 'AIマンガ', 'ショートショート']);
  assert.equal(messages[1].content, 'noteで面白そうなタグを提案してください。');
});

test('「他は何がありますか？」にも専用systemと直前の完了済み会話を原文で送る', async t => {
  const previous = '[#AIイラスト]：ComfyUIと関連する画像生成。\n[#掌編]：短い物語。';
  const f = await fixture(t, { reply: previous }), n = f.nodes;
  for (const tag of ['ComfyUI', 'AIマンガ', 'ショートショート'])
    await f.send({ type: 'tag-operation', patch: { type: 'ADD_TAG', groupId: 'group1', tag } });
  await flush(); n.get('connect-ollama').onclick(); await flush();
  await n.get('chat-actions').children[1].onclick(); await flush();
  const first = JSON.parse(f.requests.filter(item => item.url.endsWith('/api/chat'))[0].init.body);
  n.get('chat-input').value = '他は何がありますか？'; n.get('chat-form').fire('submit'); await flush();
  const second = JSON.parse(f.requests.filter(item => item.url.endsWith('/api/chat'))[1].init.body);
  assert.equal(second.messages[0].role, 'system');
  assert.equal(second.messages[0].content, first.messages[0].content);
  assert.ok(second.messages[0].content.includes('["ComfyUI","AIマンガ","ショートショート"]'));
  assert.deepEqual(second.messages.slice(1), [first.messages[1], { role: 'assistant', content: previous }, { role: 'user', content: '他は何がありますか？' }]);
  assert.equal((await f.chat('get', { actionId: 'tag-suggestion-v1' })).actionId, 'tag-suggestion-v1');
});

test('生成中の専用会話への切替は古い生成を中断し、連打でも最初の質問を一度だけ送る', async t => {
  let count = 0, aborted = false;
  const f = await fixture(t, { stream: init => {
    if (++count > 1) return new Response(JSON.stringify({ message: { role: 'assistant', content: '[#新候補]' }, done: true }) + '\n');
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('aborted', 'AbortError')); });
    } }));
  } }), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  n.get('chat-input').value = '古い生成'; n.get('chat-form').fire('submit'); await flush();
  const action = n.get('chat-actions').children[1]; assert.equal(action.disabled, false);
  const first = action.onclick(), second = action.onclick(); await Promise.all([first, second]); await flush();
  assert.equal(aborted, true); assert.equal(count, 2);
  const state = await f.chat('get', { actionId: 'tag-suggestion-v1' }); assert.equal(state.actionId, 'tag-suggestion-v1'); assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].status, 'complete'); assert.equal(state.turns[0].assistant, '[#新候補]');
  assert.match(n.get('chat-status').textContent, /完了/); assert.equal(n.get('chat-send').disabled, false);
});
test('タブはキーボードで切り替えられ、新しい会話では選択中だけ消す', async t => {
  const f = await fixture(t), n=f.nodes, tabs=n.get('chat-actions').children;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='通常の履歴';n.get('chat-form').fire('submit');await flush();
  const key=tabs[0].fire('keydown',{key:'ArrowRight'});await flush();
  assert.equal(key.defaultPrevented,true);assert.equal(f.document.activeElement,n.get('chat-input'));
  assert.equal(tabs[1].getAttribute('aria-selected'),'true');
  await n.get('chat-new').onclick();await flush();
  assert.equal(tabs[1].getAttribute('aria-selected'),'true');
  assert.equal((await f.chat('get',{actionId:'tag-suggestion-v1'})).turns.length,0);
  assert.equal((await f.chat('get')).turns[0].user,'通常の履歴');
  await tabs[0].onclick();await flush();assert.match(n.get('chat-messages').textContent,/通常の履歴/);
  await tabs[1].onclick();await flush();
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,2);
});

test('切替前の遅延した進捗保存を拒否しても、切替先の会話を停止しない', async t => {
  let release,count=0;const progressGate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{progressGate,stream:()=>new Response(JSON.stringify({message:{role:'assistant',content:++count===1?'古い進捗':'新しい回答'},done:true})+'\n')}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='通常の途中';n.get('chat-form').fire('submit');await flush();
  await n.get('chat-actions').children[1].onclick();await flush();release();await flush();
  assert.equal(n.get('chat-send').disabled,false);assert.match(n.get('chat-status').textContent,/完了/);
  assert.equal((await f.chat('get',{actionId:'tag-suggestion-v1'})).turns[0].assistant,'新しい回答');
  assert.equal((await f.chat('get')).turns[0].status,'interrupted');
});

test('Ctrl+Enterは送信ボタンと同じ処理で送信し、連続操作で二重送信しない', async t => {
  const f = await fixture(t), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  n.get('chat-input').value = 'こんにちは\n改行も維持';
  const event = n.get('chat-input').fire('keydown', { key: 'Enter', ctrlKey: true });
  n.get('chat-input').fire('keydown', { key: 'Enter', ctrlKey: true });
  await flush();
  assert.equal(event.defaultPrevented, true);
  const requests = f.requests.filter(item => item.url.endsWith('/api/chat'));
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].init.body).messages[0].content, 'こんにちは\n改行も維持');
  assert.equal((await f.chat('get')).turns[0].status, 'complete');
});
test('Enter・IME変換中・キーリピート・別の修飾キーでは送信せず、未接続時にも送信しない', async t => {
  const f = await fixture(t), n = f.nodes, input = n.get('chat-input');
  input.value = '入力途中';
  assert.equal(input.fire('keydown', { key: 'Enter', ctrlKey: true }).defaultPrevented, undefined);
  n.get('connect-ollama').onclick(); await flush();
  for (const event of [
    { key: 'Enter' }, { key: 'Enter', shiftKey: true },
    { key: 'Enter', ctrlKey: true, isComposing: true }, { key: 'Enter', ctrlKey: true, keyCode: 229 },
    { key: 'Enter', ctrlKey: true, repeat: true }, { key: 'Enter', metaKey: true },
    { key: 'Enter', ctrlKey: true, altKey: true }, { key: 'Enter', ctrlKey: true, shiftKey: true }
  ]) assert.equal(input.fire('keydown', event).defaultPrevented, undefined);
  assert.equal(f.requests.filter(item => item.url.endsWith('/api/chat')).length, 0);
  assert.equal(input.value, '入力途中');
});
test('モデル一覧200・会話403を区別し、正確な拡張Originの許可手順を表示する', async t => {
  const f = await fixture(t, { postStatus: 403 }), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  assert.match(n.get('llm-connection-status').textContent, /モデル一覧を取得/);
  assert.doesNotMatch(n.get('chat-status').textContent, /接続できました/);
  n.get('chat-input').value = 'hello'; n.get('chat-form').fire('submit'); await flush();
  assert.match(n.get('chat-status').textContent, /会話送信を拒否.*403/);
  assert.equal(n.get('ollama-origin-help').hidden, false);
  assert.equal(n.get('ollama-extension-origin').textContent, 'chrome-extension://test');
  assert.match(n.get('ollama-origin-command').value, /OLLAMA_ORIGINS/);
  assert.match(n.get('ollama-origin-command').value, /chrome-extension:\/\/test/);
  assert.doesNotMatch(n.get('ollama-origin-command').value, /chrome-extension:\/\/\*/);
  assert.equal(n.get('chat-send').disabled, true);
  assert.equal((await f.chat('get')).turns[0].status, 'interrupted');
  assert.equal(f.requests.filter(item => item.url.endsWith('/api/chat')).length, 1);
});
test('新しい会話は生成と入力と保存履歴を消し、遅れて届く内容を復活させない', async t => {
  let finish;
  const f = await fixture(t, { stream: init => new Response(new ReadableStream({
    start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { role: 'assistant', content: 'late' }, done: true }) + '\n')); controller.close(); }; init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError'))); }
  })) }), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  n.get('chat-input').value = 'secret'; n.get('chat-form').fire('submit'); await flush();
  assert.equal(n.get('chat-stop').disabled, false);
  n.get('chat-input').value = 'draft'; await n.get('chat-new').onclick(); await flush();
  assert.deepEqual((await f.chat('get')).turns, []); assert.equal(n.get('chat-input').value, '');
  assert.doesNotMatch(n.get('chat-messages').textContent, /secret|late/);
  assert.equal(typeof finish, 'function');
});
test('接続先変更と取消を区別し、変更時は会話・入力・モデルを初期化して自動接続しない', async t => {
  const f = await fixture(t), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  n.get('chat-input').value = 'draft'; n.get('ollama-url').value = 'http://192.168.1.8:11434';
  n.get('ollama-settings').fire('submit'); await flush();
  assert.equal((await f.settings()).ollamaModel, ''); assert.equal(n.get('chat-input').value, '');
  assert.equal(f.requests.length, 1); assert.equal((await f.chat('get')).approvedUrl, '');
  const cancel = await fixture(t, { confirm: false }); cancel.nodes.get('ollama-url').value = 'http://192.168.1.9:11434';
  cancel.nodes.get('ollama-settings').fire('submit'); await flush();
  assert.equal((await cancel.settings()).ollamaUrl, 'http://127.0.0.1:11434');
});
test('生成中に設定へ移動すると通信を中断し、戻っても自動再送しない', async t => {
  let wasAborted = false;
  const f = await fixture(t, { stream: init => new Response(new ReadableStream({
    start(controller) { init.signal.addEventListener('abort', () => { wasAborted = true; controller.error(new DOMException('aborted', 'AbortError')); }); }
  })) }), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  n.get('chat-input').value = 'hello'; n.get('chat-form').fire('submit'); await flush();
  n.get('nav-settings').onclick(); await flush(); assert.equal(wasAborted, true);
  assert.equal((await f.chat('get')).turns[0].status, 'interrupted');
  n.get('nav-chat').onclick(); await flush(); assert.equal(f.requests.filter(item => item.url.endsWith('/api/chat')).length, 1);
});
test('LLMの設定を通常の設定と分離し、接続URLとシステムプロンプトを配置する', async t => {
  const f = await fixture(t, { hash: '#llm' }), n = f.nodes;
  assert.equal(n.get('panel-llm').hidden, false); assert.equal(n.get('panel-settings').hidden, true);
  assert.equal(n.get('panel-llm').contains(n.get('ollama-settings')), true);
  assert.equal(n.get('panel-llm').contains(n.get('system-prompt-settings')), true);
  assert.equal(n.get('panel-settings').contains(n.get('ollama-url')), false);
  n.get('nav-settings').onclick(); assert.equal(n.get('panel-llm').hidden, true); assert.equal(n.get('panel-settings').hidden, false);
  n.get('nav-llm').onclick(); assert.equal(n.get('panel-llm').hidden, false);
});
test('プロンプト保存後の送信にsystemメッセージを付け、空欄保存で解除する', async t => {
  const f = await fixture(t), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush(); n.get('nav-llm').onclick();
  n.get('system-prompt').value = '日本語で回答する。\nそのまま保存'; n.get('system-prompt').fire('input');
  n.get('system-prompt-settings').fire('submit'); await flush();
  assert.equal((await f.settings()).ollamaSystemPrompt, '日本語で回答する。\nそのまま保存');
  assert.match(n.get('system-prompt-status').textContent, /保存し、通常の会話を初期化/);
  n.get('nav-chat').onclick(); n.get('chat-input').value = 'hi'; n.get('chat-form').fire('submit'); await flush();
  let messages = JSON.parse(f.requests.find(item => item.url.endsWith('/api/chat')).init.body).messages;
  assert.deepEqual(messages, [{ role: 'system', content: '日本語で回答する。\nそのまま保存' }, { role: 'user', content: 'hi' }]);
  n.get('nav-llm').onclick(); n.get('system-prompt').value = ''; n.get('system-prompt').fire('input');
  n.get('system-prompt-settings').fire('submit'); await flush(); assert.deepEqual((await f.chat('get')).turns, []);
  n.get('nav-chat').onclick(); n.get('chat-input').value = 'new'; n.get('chat-form').fire('submit'); await flush();
  messages = JSON.parse(f.requests.filter(item => item.url.endsWith('/api/chat')).at(-1).init.body).messages;
  assert.deepEqual(messages, [{ role: 'user', content: 'new' }]);
});
test('プロンプト保存の取消では履歴・入力・設定を変更せず、未保存のプロンプトも送信しない', async t => {
  const f = await fixture(t, { confirm: false }), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  n.get('chat-input').value = 'draft'; n.get('nav-llm').onclick();
  n.get('system-prompt').value = 'unsaved'; n.get('system-prompt').fire('input');
  n.get('system-prompt-settings').fire('submit'); await flush();
  assert.equal((await f.settings()).ollamaSystemPrompt, ''); assert.equal(n.get('chat-input').value, 'draft');
  n.get('nav-chat').onclick(); n.get('chat-form').fire('submit'); await flush();
  assert.deepEqual(JSON.parse(f.requests.find(item => item.url.endsWith('/api/chat')).init.body).messages, [{ role: 'user', content: 'draft' }]);
});
test('別タブのプロンプト変更で未保存入力を上書きせず、そのままの再保存も拒否する', async t => {
  const f = await fixture(t), n = f.nodes;
  n.get('nav-llm').onclick(); n.get('system-prompt').value = 'local draft'; n.get('system-prompt').fire('input');
  await f.save({ ollamaSystemPrompt: 'other tab' }); await flush();
  assert.equal(n.get('system-prompt').value, 'local draft');
  n.get('system-prompt-settings').fire('submit'); await flush();
  assert.equal((await f.settings()).ollamaSystemPrompt, 'other tab'); assert.match(n.get('system-prompt-status').textContent, /別の画面/);
});
test('接続先変更で保存済みと編集中のプロンプトを消し、旧接続先の指示を持ち越さない', async t => {
  const f = await fixture(t), n = f.nodes;
  await f.save({ ollamaSystemPrompt: 'old private instruction' }); await flush();
  n.get('nav-llm').onclick(); n.get('system-prompt').value = 'old draft'; n.get('system-prompt').fire('input');
  n.get('ollama-url').value = 'http://192.168.1.10:11434'; n.get('ollama-settings').fire('submit'); await flush();
  assert.equal((await f.settings()).ollamaSystemPrompt, ''); assert.equal(n.get('system-prompt').value, '');
  assert.equal(n.get('system-prompt-status').textContent.includes('未保存'), false);
  assert.equal(f.requests.length, 0);
});
test('設定JSONの明示読込では未保存のプロンプトを破棄して読込値を表示する', async t => {
  const f = await fixture(t), n = f.nodes;
  n.get('nav-llm').onclick(); n.get('system-prompt').value = 'unsaved'; n.get('system-prompt').fire('input');
  n.get('nav-transfer').onclick(); n.get('settings-json').value = JSON.stringify({ format: 'oshaberi-note-settings', schemaVersion: 1, settings: { ollamaSystemPrompt: 'imported' } });
  n.get('settings-json').oninput(); n.get('import-settings').onclick(); await flush();
  assert.equal((await f.settings()).ollamaSystemPrompt, 'imported');
  assert.equal(n.get('system-prompt').value, 'imported'); assert.equal(n.get('system-prompt-status').textContent, '');
});
test('長い記事を送信でき、入力上限超過の後も短く直せば再読み込みなしで送信できる', async t => {
  const f=await fixture(t),n=f.nodes;n.get('connect-ollama').onclick();await flush();
  n.get('chat-input').value='a'.repeat(200001);n.get('chat-form').fire('submit');await flush();
  assert.equal(n.get('chat-send').disabled,false);assert.equal(n.get('chat-input').value.length,200001);
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,0);
  const article='長い記事の本文です。'.repeat(18000);
  n.get('chat-input').value=article;n.get('chat-form').fire('submit');await flush();
  assert.equal((await f.chat('get')).turns[0].status,'complete');
  assert.equal(JSON.parse(f.requests.find(item=>item.url.endsWith('/api/chat')).init.body).messages.at(-1).content,article);
});
test('10往復を超えてもUIから会話を続け、履歴を外した件数を表示する', async t => {
  const f=await fixture(t),n=f.nodes;n.get('connect-ollama').onclick();await flush();
  for(let i=0;i<12;i++){n.get('chat-input').value='turn-'+i;n.get('chat-form').fire('submit');await flush();}
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,12);
  assert.equal((await f.chat('get')).turns.length,10);assert.match(n.get('chat-history-info').textContent,/2往復を保存から外し/);
  assert.equal(n.get('chat-send').disabled,false);
});
test('接続・モデル・説明・履歴案内をLLM設定に置き、設定画面から接続して会話へ戻れる', async t => {
  const f=await fixture(t,{hash:'#llm'}),n=f.nodes;
  for(const id of ['connect-ollama','chat-model','chat-endpoint','llm-connection-status','chat-history-info','ollama-origin-help']){
    assert.equal(n.get('panel-llm').contains(n.get(id)),true,id);
    assert.equal(n.get('panel-chat').contains(n.get(id)),false,id);
  }
  assert.equal(n.get('panel-chat').contains(n.get('chat-status')),true);
  const html=source('home.html'),chatHtml=html.split('<section id="panel-chat"')[1].split('</section>')[0],llmHtml=html.split('<section id="panel-llm"')[1].split('</section>')[0];
  assert.doesNotMatch(chatHtml,/入力したメッセージ・完了済み|クラウドモデルでは|履歴は直近10往復/);
  assert.match(llmHtml,/入力したメッセージ・完了済み/);
  n.get('connect-ollama').onclick();await flush();
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/tags')).length,1);
  assert.match(n.get('llm-connection-status').textContent,/モデル一覧を取得/);
  n.get('chat-model').value='local';await n.get('chat-model').onchange();await flush();
  n.get('nav-chat').onclick();assert.equal(n.get('chat-send').disabled,false);
  n.get('chat-input').value='設定から戻って会話';n.get('chat-form').fire('submit');await flush();
  assert.equal((await f.chat('get')).turns[0].status,'complete');assert.match(n.get('chat-status').textContent,/応答が完了/);
});
test('送信直後に入力へフォーカスを戻し、生成中の下書きを応答完了後も保持する',async t=>{
  let finish;
  const f=await fixture(t,{stream:()=>new Response(new ReadableStream({start(controller){finish=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({message:{role:'assistant',content:'回答'},done:true})+'\n'));controller.close();};}}))}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();
  n.get('chat-input').value='最初の質問';n.get('chat-send').focus();n.get('chat-form').fire('submit');await flush();
  assert.equal(f.document.activeElement,n.get('chat-input'));assert.equal(n.get('chat-input').disabled,false);
  assert.equal(n.get('chat-send').disabled,true);
  n.get('chat-input').value='次の質問の下書き';n.get('chat-input').fire('keydown',{key:'Enter',ctrlKey:true});
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,1);
  finish();await flush();assert.equal(n.get('chat-input').value,'次の質問の下書き');assert.equal(n.get('chat-send').disabled,false);
  assert.equal(f.document.activeElement,n.get('chat-input'));
});
test('完了したAI回答のタグだけをボタン化し、検索と実際の4グループを選べる',async t=>{
  const reply='1. [#週末の過ごし方]：週末の案です。\n2. [#a/b? x]：別の案。';
  const f=await fixture(t,{reply}),n=f.nodes;
  await f.c.OshaberiNotePlatform.tag({type:'RENAME_TAG_GROUP',groupId:'group2',name:'読み物',expectedName:''});await flush();
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='[#ユーザーの入力]';n.get('chat-form').fire('submit');await flush();
  const rows=n.get('chat-messages').children,buttons=rows[1].querySelectorAll('button');
  assert.equal(rows[0].querySelectorAll('button').length,0);assert.equal(buttons.length,2);
  assert.equal(rows[1].querySelector('p').textContent,reply);assert.equal((await f.chat('get')).turns[0].assistant,reply);
  assert.deepEqual((await f.settings()).tagGroups[1].tags,[]);
  buttons[0].onclick();assert.equal(n.get('chat-tag-dialog').open,true);
  assert.equal(n.get('chat-tag-search').href,f.c.OshaberiNote.tagUrl('週末の過ごし方'));
  assert.equal(n.get('chat-tag-search').getAttribute('target'),'_blank');
  const groups=n.get('chat-tag-groups').children;assert.equal(groups.length,4);assert.equal(groups[1].textContent,'②読み物に登録');
  groups[1].onclick();await flush();
  assert.deepEqual((await f.settings()).tagGroups[1].tags,['週末の過ごし方']);assert.equal((await f.settings()).selectedTagGroupId,'group1');
  assert.equal(groups[1].disabled,true);assert.match(groups[1].textContent,/登録済み/);
  n.get('chat-tag-close').onclick();buttons[1].onclick();
  assert.equal(n.get('chat-tag-search').href,'https://note.com/search?q=%23a%2Fb%3F%20x&context=note&mode=search&sort=new');
  n.get('chat-tag-search').fire('click');assert.equal(n.get('chat-tag-dialog').open,true);
  assert.equal(n.get('chat-tag-heading').textContent,'#a/b? x');
  groups[2].onclick();await flush();assert.deepEqual((await f.settings()).tagGroups[2].tags,['a/b? x']);
  assert.equal(n.get('chat-tag-dialog').open,true);
  n.get('chat-tag-close').onclick();assert.equal(n.get('chat-tag-dialog').open,false);
});
test('生成途中と中断した応答はボタン化せず、完了応答のHTMLも実行しない',async t=>{
  const f=await fixture(t,{stream:init=>new Response(new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode(JSON.stringify({message:{role:'assistant',content:'途中 [#タグ]'},done:false})+'\n'));
    init.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')));
  }}))}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='hi';n.get('chat-form').fire('submit');await flush();
  assert.equal(n.get('chat-messages').querySelectorAll('button').length,0);
  await n.get('chat-stop').onclick();await flush();assert.equal(n.get('chat-messages').querySelectorAll('button').length,0);
  const html=await fixture(t,{reply:'<img src=x onerror=alert(1)> [#<script>]'}),h=html.nodes;
  h.get('connect-ollama').onclick();await flush();h.get('chat-input').value='hi';h.get('chat-form').fire('submit');await flush();
  assert.equal(h.get('chat-messages').querySelector('img'),null);assert.equal(h.get('chat-messages').querySelector('script'),null);
  assert.equal(h.get('chat-messages').querySelector('button').textContent,'[#<script>]');
});
test('タグ解析は既知の表記だけを扱い、表示原文を維持して最大100個まで操作化する',async t=>{
  const f=await fixture(t),parse=f.c.OshaberiNoteChatTags.parts;
  for(const text of ['#タグ [＃タグ] [#] [#  ]','[#改行\nタグ]','[#制御\u0000文字]'])assert.equal(parse(text).some(part=>part.tag),false);
  const text='[#タグ] '.repeat(101),parts=parse(text);assert.equal(parts.filter(part=>part.tag).length,100);assert.equal(parts.map(part=>part.text).join(''),text);
});
test('登録中の連打を止め、結果未確認なら自動再送せず登録を止める',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{reply:'[#tag]',tagGate:gate}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='hi';n.get('chat-form').fire('submit');await flush();
  n.get('chat-messages').querySelector('button').onclick();const button=n.get('chat-tag-groups').children[0];
  button.onclick();button.onclick();assert.equal(button.disabled,true);release();await flush();assert.deepEqual((await f.settings()).tagGroups[0].tags,['tag']);
  const uncertain=await fixture(t,{reply:'[#tag]',tagError:true}),u=uncertain.nodes;
  u.get('connect-ollama').onclick();await flush();u.get('chat-input').value='hi';u.get('chat-form').fire('submit');await flush();
  u.get('chat-messages').querySelector('button').onclick();u.get('chat-tag-groups').children[0].onclick();await flush();
  assert.match(u.get('chat-tag-status').textContent,/自動再送は行いません/);assert.equal(u.get('chat-tag-groups').children[1].disabled,true);
  assert.deepEqual((await uncertain.settings()).tagGroups[0].tags,[]);
});
