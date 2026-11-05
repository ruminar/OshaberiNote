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
      return new Response(JSON.stringify({ message: { role: 'assistant', content: '<script>alert(1)</script>こんにちは' }, done: true }) + '\n');
    }
  });
  c.chrome.permissions.request = async permission => { grants.push(structuredClone(permission)); return options.grant !== false; };
  c.chrome.runtime.sendMessage = async message => {
    try { return { ok: true, settings: await f.send(message) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  c.chrome.runtime.connect = ({ name }) => {
    const disconnect = f.connect(name.slice('oshaberi-chat:'.length));
    return { onDisconnect: { addListener() {} }, postMessage() {}, disconnect };
  };
  for (const file of ['src/home.js', 'src/ollama.js', 'src/chat-ui.js']) vm.runInContext(source(file), c, { filename: file });
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
  assert.deepEqual(JSON.parse(f.requests[1].init.body).messages, [{ role: 'user', content: 'hello\nworld' }]);
});
test('権限拒否時にはAPIへ接続せず、既存の設定・お気に入りを利用できる', async t => {
  const f = await fixture(t, { grant: false }), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  assert.equal(f.requests.length, 0); assert.equal(n.get('chat-send').disabled, true);
  n.get('nav-tags').onclick(); assert.equal(n.get('panel-tags').hidden, false); assert.equal(n.get('add-tag').disabled, false);
});
test('モデル一覧200・会話403を区別し、正確な拡張Originの許可手順を表示する', async t => {
  const f = await fixture(t, { postStatus: 403 }), n = f.nodes;
  n.get('connect-ollama').onclick(); await flush();
  assert.match(n.get('chat-status').textContent, /モデル一覧を取得/);
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
