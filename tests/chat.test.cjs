const { test } = require('node:test');
const assert = require('node:assert/strict'), vm = require('node:vm');
const backend = require('./helpers/chat.cjs');
const { source } = backend;
const flush = () => new Promise(resolve => setImmediate(resolve));
async function ready() {
  const f = backend(); f.connect();
  await f.save({ ollamaModel: 'local-model' });
  const state = await f.chat('get');
  const patch = { endpoint: state.endpoint, epoch: state.epoch, owner: 'owner', model: 'local-model' };
  await f.chat('approve', patch);
  return { f, patch };
}
test('初回は未許可・初期履歴なし。note上から会話APIを呼べない', async () => {
  const f = backend(); f.connect(); const state = await f.chat('get');
  assert.equal(state.approvedUrl, ''); assert.deepEqual(state.turns, []);
  await assert.rejects(f.chat('start', { epoch: state.epoch, endpoint: state.endpoint, owner: 'owner', model: 'x', text: 'hello' }), /未許可/);
  assert.equal(await f.send({ type: 'chat-operation', operation: 'get' }, { id: 'test', url: 'https://note.com/', frameId: 0, tab: { id: 1 } }), undefined);
});
test('複数タブからの開始を直列化し、同時生成を一件に制限する', async () => {
  const { f, patch } = await ready(); f.connect('other');
  const results = await Promise.allSettled([f.chat('start', { ...patch, text: 'first' }), f.chat('start', { ...patch, owner: 'other', text: 'second' })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.match(results.find(item => item.status === 'rejected').reason.message, /別の画面/);
  assert.equal((await f.chat('get')).turns.length, 1);
});
test('完了した会話だけを次回へ送り、中断した入力と応答は除外する', async () => {
  const { f, patch } = await ready();
  let state = await f.chat('start', { ...patch, text: 'first' });
  await f.chat('complete', { ...patch, id: state.active.id, text: 'answer' });
  state = await f.chat('start', { ...patch, text: 'interrupted' });
  await f.chat('progress', { ...patch, id: state.active.id, text: 'partial' });
  await f.chat('stop');
  state = await f.chat('start', { ...patch, text: 'next' });
  assert.deepEqual(state.messages, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'next' }]);
  assert.equal(state.turns[1].status, 'interrupted');
});
test('新しい会話の後、遅延した応答と別タブの古いepochを拒否する', async () => {
  const { f, patch } = await ready(); const old = await f.chat('start', { ...patch, text: 'secret' });
  const next = await f.chat('reset'); assert.notEqual(next.epoch, patch.epoch); assert.deepEqual(next.turns, []);
  await assert.rejects(f.chat('complete', { ...patch, id: old.active.id, text: 'late' }), /変更/);
  await assert.rejects(f.chat('start', { ...patch, text: 'old tab' }), /変更/);
  assert.deepEqual((await f.chat('get')).turns, []);
});
test('接続先変更は設定と履歴を一括保存し、許可・モデル・会話を初期化する', async () => {
  const { f, patch } = await ready(); const old = await f.chat('start', { ...patch, text: 'private' });
  await f.save({ ollamaUrl: 'http://192.168.1.2:11434/' });
  const settings = await f.settings(), state = await f.chat('get');
  assert.equal(settings.ollamaUrl, 'http://192.168.1.2:11434'); assert.equal(settings.ollamaModel, '');
  assert.equal(state.endpoint, settings.ollamaUrl); assert.equal(state.approvedUrl, ''); assert.deepEqual(state.turns, []);
  await assert.rejects(f.chat('complete', { ...patch, id: old.active.id, text: 'late' }));
  await assert.rejects(f.chat('start', { endpoint: state.endpoint, epoch: state.epoch, model: 'x', owner: 'owner', text: 'new' }), /未許可/);
});
test('接続先変更の保存失敗では元の設定と会話を保持する', async () => {
  const { f, patch } = await ready(); await f.chat('start', { ...patch, text: 'keep' });
  const before = structuredClone(f.data); f.fail = true;
  await assert.rejects(f.save({ ollamaUrl: 'http://192.168.1.2:11434' }), /storage failed/);
  assert.deepEqual(f.data, before);
});
test('モデル変更・OFF・権限取消で生成を中断し、遅延した完了を拒否する', async () => {
  for (const operation of ['model', 'off', 'permission']) {
    const { f, patch } = await ready(); const state = await f.chat('start', { ...patch, text: 'hello' });
    if (operation === 'model') await f.save({ ollamaModel: 'new-model' });
    if (operation === 'off') await f.save({ enabled: false });
    if (operation === 'permission') { f.allowed = false; f.handlers.removed[0](); await flush(); }
    assert.equal((await f.chat('get')).turns[0].status, 'interrupted');
    await assert.rejects(f.chat('complete', { ...patch, id: state.active.id, text: 'late' }));
  }
});
test('ページの接続切断を検知して中断する。背景再起動後の孤立生成も再送しない', async () => {
  const { f, patch } = await ready(); const disconnect = f.connect('another');
  await f.chat('start', { ...patch, owner: 'another', text: 'hello' }); disconnect(); await flush();
  assert.equal((await f.chat('get')).turns[0].status, 'interrupted');
  const orphan = f.context.OshaberiNoteChatState.fresh(patch.endpoint);
  orphan.turns = [{ user: 'old', assistant: '', status: 'pending' }]; orphan.active = { id: 'orphan', owner: 'closed' };
  f.data[f.context.OshaberiNoteChatState.key] = orphan;
  const state = await f.chat('get'); assert.equal(state.active, null); assert.equal(state.turns[0].status, 'interrupted');
});
test('入力・応答・送信履歴・会話件数の上限で拒否し、勝手に履歴を削除しない', async () => {
  const { f, patch } = await ready();
  await assert.rejects(f.chat('start', { ...patch, text: 'x'.repeat(8001) }), /8,000/);
  let state = await f.chat('start', { ...patch, text: 'x' });
  await assert.rejects(f.chat('progress', { ...patch, id: state.active.id, text: 'x'.repeat(32001) }), /長さ/);
  await f.chat('complete', { ...patch, id: state.active.id, text: 'x'.repeat(32000) });
  await assert.rejects(f.chat('start', { ...patch, text: 'next' }), /上限/);
  assert.equal((await f.chat('get')).turns[0].assistant.length, 32000);
  state = await f.chat('reset');
  const raw = f.data[f.context.OshaberiNoteChatState.key];
  raw.turns = Array.from({ length: 100 }, () => ({ user: 'x', assistant: 'y', status: 'complete' }));
  await assert.rejects(f.chat('start', { ...patch, epoch: state.epoch, text: 'next' }), /上限/);
});
test('不正な会話データは通信せず、新しい会話でのみ明示的に復旧できる', async () => {
  const { f } = await ready(); f.data[f.context.OshaberiNoteChatState.key].turns = [{ user: '<script>', assistant: {}, status: 'complete' }];
  await assert.rejects(f.chat('get'), /不正/);
  assert.deepEqual((await f.chat('reset')).turns, []);
});
test('不正なON/OFF保存値を有効と推測せず、通信開始を拒否する', async () => {
  const { f, patch } = await ready();
  f.data[f.context.OshaberiNote.settingsKey].enabled = 'true';
  await assert.rejects(f.chat('start', { ...patch, text: 'hello' }), /保存値が不正/);
});
function client(chunks, options = {}) {
  let request;
  const c = vm.createContext({ URL, TextDecoder, TextEncoder, console, fetch: async (url, init) => {
    request = { url, ...init };
    return new Response(new ReadableStream({ start(controller) { for (const part of chunks) controller.enqueue(part); controller.close(); } }), { status: options.status ?? 200 });
  } });
  for (const file of ['src/common.js', 'src/chat-state.js', 'src/ollama.js']) vm.runInContext(source(file), c);
  return { api: c.OshaberiNoteOllama, get request() { return request; } };
}
const encoded = text => new TextEncoder().encode(text);
const line = (content, done) => JSON.stringify({ message: { role: 'assistant', content }, done }) + '\n';
test('NDJSONと日本語のUTF-8が任意のバイト位置で分割されてもストリーミング復元する', async () => {
  const bytes = encoded(line('こんにちは', false) + line('！', true));
  const f = client(Array.from(bytes, byte => new Uint8Array([byte]))), parts = [];
  assert.equal(await f.api.chat('http://127.0.0.1:11434', 'local', [{ role: 'user', content: 'hi' }], new AbortController().signal, text => parts.push(text)), 'こんにちは！');
  assert.deepEqual(parts, ['こんにちは', 'こんにちは！']);
  assert.equal(f.request.credentials, 'omit'); assert.equal(f.request.redirect, 'error'); assert.equal(f.request.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(f.request.body).messages, [{ role: 'user', content: 'hi' }]);
});
test('途中切断・不正JSON・HTTP異常・完了後の余分な行は成功扱いにしない', async () => {
  for (const data of [line('partial', false), '{bad}\n', line('ok', true) + line('late', true), JSON.stringify({ error: 'server error' }) + '\n']) {
    const f = client([encoded(data)]); await assert.rejects(f.api.chat('http://localhost:11434', 'local', [], new AbortController().signal, () => {}));
  }
  const f = client([encoded('no')], { status: 403 }); await assert.rejects(f.api.models('http://localhost:11434', new AbortController().signal), /403/);
});
test('中止されたストリームと巨大応答を停止する', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(client([encoded(line('a', true))]).api.chat('http://localhost:11434', 'local', [], signal, () => {}));
  await assert.rejects(client([encoded(line('a'.repeat(32001), true))]).api.chat('http://localhost:11434', 'local', [], new AbortController().signal, () => {}), /32,000/);
});
test('モデル一覧の形式とモデル名を検証し、インストール済みモデルだけ返す', async () => {
  const f = client([encoded(JSON.stringify({ models: [{ name: 'local:a' }, { name: 'local:b' }] }))]);
  assert.deepEqual(Array.from(await f.api.models('http://localhost:11434', new AbortController().signal)), ['local:a', 'local:b']);
  await assert.rejects(client([encoded('{"models":[{"name":"bad name"}]}')]).api.models('http://localhost:11434', new AbortController().signal));
});
