const { test } = require('node:test'), assert = require('node:assert/strict');
const backend = require('./helpers/chat.cjs');
const homeFixture = require('./helpers/home.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
function own(settings) { return JSON.stringify({ format: 'oshaberi-note-settings', schemaVersion: 1, settings }); }
function legacy(settings, schemaVersion = 7) { return JSON.stringify({ format: 'hikikomori-note-settings', schemaVersion, settings }); }
test('自製JSONは独立形式1で全対応設定を往復し、モード・権限・会話を出力しない', async () => {
  const f = backend(), core = f.context.OshaberiNote;
  await f.save({ theme: 'dark', ollamaModel: 'local', noteUserId: 'sample', hidePaidArticles: true });
  const state = await f.settings(), json = core.exportSettings(state), doc = JSON.parse(json);
  assert.equal(doc.format, 'oshaberi-note-settings'); assert.equal(doc.schemaVersion, 1);
  for (const key of ['mode', 'legacyMode', 'turns', 'active', 'approvedUrl', 'tagGroupsRevision']) assert.equal(Object.hasOwn(doc.settings, key), false);
  assert.equal(doc.settings.ollamaModel, 'local');
  assert.equal(core.parseSettingsExport(json).noteUserId, 'sample');
  assert.equal(core.parseSettingsExport(json).hidePaidArticles, true);
  assert.equal(core.parseSettingsExport(json).theme, 'dark');
  assert.equal(core.parseSettingsExport(own({ enabled: false }), state).theme, 'dark');
});
test('旧形式1～7の存在する項目だけを適用し、モード・Ollama値・未知項目を捨てる', async () => {
  const f = backend(), core = f.context.OshaberiNote;
  const current = core.readSettings({ ...core.defaultSettings(), hideLikeCounts: true, noteUserId: 'keep', ollamaModel: 'keep-model' });
  for (let version = 1; version <= 7; version++) {
    const result = core.parseSettingsExport(legacy({ enabled: false, noteUserId: '', mode: 'severe', legacyMode: true, ollamaUrl: 'https://evil.test', ollamaModel: 'evil', unknown: 'ignore' }, version), current);
    assert.equal(result.enabled, false); assert.equal(result.noteUserId, ''); assert.equal(result.mode, 'normal');
    assert.equal(result.hideLikeCounts, true); assert.equal(result.ollamaUrl, current.ollamaUrl); assert.equal(result.ollamaModel, 'keep-model'); assert.equal(Object.hasOwn(result, 'unknown'), false);
  }
});
test('省略項目は保持し、falseと空文字・空配列は値として適用する', async () => {
  const f = backend(), core = f.context.OshaberiNote;
  const current = core.readSettings({ ...core.defaultSettings(), enabled: true, hidePaidArticles: true, noteUserId: 'keep', authorDisplayRules: [{ userId: 'other', displayName: 'Other', action: 'hide' }] });
  let result = core.parseSettingsExport(own({ enabled: false }), current);
  assert.equal(result.enabled, false); assert.equal(result.hidePaidArticles, true); assert.equal(result.authorDisplayRules.length, 1);
  result = core.parseSettingsExport(own({ authorDisplayRules: [], noteUserId: '' }), current);
  assert.equal(result.authorDisplayRules.length, 0); assert.equal(result.noteUserId, '');
});
test('古いタグ形式と作者・マガジン・メンバーシップを既知バージョンに従って復元する', async () => {
  const f = backend(), core = f.context.OshaberiNote;
  for (let version = 1; version <= 7; version++) {
    const groups = Array.from({ length: 4 }, (_, i) => ({ id: 'group' + (i + 1), name: '', [version < 5 ? 'tags' : 'items']: i === 0 ? version < 5 ? ['AI'] : [{ type: 'tag', tag: 'AI' }, { type: 'user', userId: 'author', displayName: '' }, ...(version >= 6 ? [{ type: 'membership', userId: 'author', displayName: '' }] : [])] : [] }));
    const result = core.parseSettingsExport(legacy({ tagGroups: groups }, version));
    assert.equal(result.tagGroups[0].tags[0], 'AI');
    if (version >= 5) assert.equal(result.tagGroups[0].tags[1].type, 'user');
    if (version >= 6) assert.equal(result.tagGroups[0].tags[2].type, 'membership');
  }
});
test('対応項目の不正値・未知形式・未来バージョン・巨大JSONでは全体を拒否する', async () => {
  const f = backend(), core = f.context.OshaberiNote;
  for (const settings of [{ enabled: 'false' }, { noteUserId: '<script>' }, { tagGroups: [] }, { authorDisplayRules: [{}] }, { ollamaUrl: 'http://user:pass@localhost:11434' }, { ollamaModel: 'bad name' }]) assert.throws(() => core.parseSettingsExport(own(settings)));
  for (const json of ['{bad', '{"format":"unknown","schemaVersion":1,"settings":{}}', '{"format":"hikikomori-note-settings","schemaVersion":8,"settings":{}}', ' '.repeat(1048577)]) assert.throws(() => core.parseSettingsExport(json));
});
test('不正な移行は保存せず、既存設定と会話を保持する', async () => {
  const f = backend(); const state = await f.settings(), before = structuredClone(f.data);
  await assert.rejects(f.send({ type: 'import-settings', patch: { json: own({ enabled: false, noteUserId: '<script>' }), expectedToken: f.context.OshaberiNote.settingsToken(state) } }));
  assert.deepEqual(f.data, before);
});
test('読込で接続先を変更すると会話とモデルを削除し、自動接続を許可しない', async () => {
  const f = backend(); f.connect(); await f.save({ ollamaModel: 'local' });
  const chat = await f.chat('get'), patch = { epoch: chat.epoch, endpoint: chat.endpoint, owner: 'owner', model: 'local' };
  await f.chat('approve', patch); await f.chat('start', { ...patch, text: 'secret' });
  const state = await f.settings();
  await f.send({ type: 'import-settings', patch: { json: own({ ollamaUrl: 'http://192.168.1.5:11434', ollamaModel: 'imported' }), expectedToken: f.context.OshaberiNote.settingsToken(state) } });
  const next = await f.chat('get'); assert.deepEqual(next.turns, []); assert.equal(next.approvedUrl, ''); assert.equal((await f.settings()).ollamaModel, '');
});
test('同一接続先の読込でも生成を中断して接続許可を解除し、古い設定トークンは拒否する', async () => {
  const f = backend(); f.connect(); await f.save({ ollamaModel: 'local' });
  const chat = await f.chat('get'), patch = { epoch: chat.epoch, endpoint: chat.endpoint, owner: 'owner', model: 'local' };
  await f.chat('approve', patch); await f.chat('start', { ...patch, text: 'hello' });
  const state = await f.settings(), token = f.context.OshaberiNote.settingsToken(state);
  await f.send({ type: 'import-settings', patch: { json: own({ hidePaidArticles: true }), expectedToken: token } });
  const next = await f.chat('get'); assert.equal(next.approvedUrl, ''); assert.equal(next.turns[0].status, 'interrupted');
  await assert.rejects(f.send({ type: 'import-settings', patch: { json: own({ hidePaidArticles: false }), expectedToken: token } }), /別の画面/);
});
test('設定移行画面に適用・破棄項目を示し、部分読込を確認して適用する', async () => {
  const f = homeFixture({ hash: '#transfer', state: { noteUserId: 'keep' } }); await flush();
  const n = f.nodes; n.get('settings-json').value = legacy({ enabled: false, mode: 'social', unknown: 1 }); n.get('settings-json').oninput();
  assert.match(n.get('transfer-validation').textContent, /適用項目：enabled/); assert.match(n.get('transfer-validation').textContent, /破棄項目：mode、unknown/);
  n.get('import-settings').onclick(); await flush(); assert.equal(f.state.enabled, false); assert.equal(f.state.noteUserId, 'keep');
});
test('固定モードは保存値のsevere/socialに影響されず、モード変更要求を拒否する', async () => {
  const f = backend(), core = f.context.OshaberiNote;
  for (const mode of ['severe', 'social', 'unknown']) assert.equal(core.readSettings({ ...core.defaultSettings(), mode }).mode, 'normal');
  await assert.rejects(f.save({ mode: 'social' }));
});
test('接続URLはオリジンだけ許可し、認証・経路・クエリ・スキームの混入を拒否する', () => {
  const core = backend().context.OshaberiNote;
  assert.equal(core.normalizeOllamaUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(core.normalizeOllamaUrl('https://example.test'), 'https://example.test');
  for (const url of ['file:///tmp', 'http://@localhost', 'http://user:pass@localhost', 'http://localhost/a/..', 'http://localhost/?', 'http://localhost/#', 'http://localhost/api', 'http://localhost\\evil', 'http://localhost\n']) assert.throws(() => core.normalizeOllamaUrl(url));
});
test('システムプロンプトを自製JSONで往復し、省略時は保持・旧製品の同名項目は破棄する', async () => {
  const f = backend(), core = f.context.OshaberiNote;
  await f.save({ ollamaSystemPrompt: 'system\n調査用' }); const state = await f.settings();
  const json = core.exportSettings(state); assert.equal(JSON.parse(json).settings.ollamaSystemPrompt, 'system\n調査用');
  assert.equal(core.parseSettingsExport(json).ollamaSystemPrompt, 'system\n調査用');
  assert.equal(core.parseSettingsExport(own({}), state).ollamaSystemPrompt, state.ollamaSystemPrompt);
  assert.equal(core.parseSettingsExport(legacy({ ollamaSystemPrompt: 'ignored' }), state).ollamaSystemPrompt, state.ollamaSystemPrompt);
  assert.equal(core.parseSettingsExport(own({ ollamaSystemPrompt: '' }), state).ollamaSystemPrompt, '');
  for (const value of [null, false, {}, 'x'.repeat(8001)]) assert.throws(() => core.parseSettingsExport(own({ ollamaSystemPrompt: value }), state));
});
test('JSONからのプロンプト変更でも履歴を初期化し、接続許可は解除する', async () => {
  const f = backend(); f.connect(); await f.save({ ollamaModel: 'local' });
  const state = await f.chat('get'), patch = { epoch: state.epoch, endpoint: state.endpoint, owner: 'owner', model: 'local' };
  await f.chat('approve', patch); await f.chat('start', { ...patch, text: 'old' });
  const settings = await f.settings();
  await f.send({ type: 'import-settings', patch: { json: own({ ollamaSystemPrompt: 'new system' }), expectedToken: f.context.OshaberiNote.settingsToken(settings) } });
  const next = await f.chat('get'); assert.deepEqual(next.turns, []); assert.equal(next.approvedUrl, '');
  assert.equal((await f.settings()).ollamaSystemPrompt, 'new system');
});
test('廃止したロゴ戻る設定は旧保存・両JSONで無視し、保存・再出力しない',async()=>{
 const f=backend(),core=f.context.OshaberiNote;const settings=core.defaultSettings();
 f.data[core.settingsKey]={...settings,noteLogoBrowserBack:true};
 assert.equal(Object.hasOwn(await f.settings(),'noteLogoBrowserBack'),false);
 for(const json of [own({noteLogoBrowserBack:true,hidePaidArticles:true}),legacy({noteLogoBrowserBack:'ignored',hidePaidArticles:true})]){
  const parsed=core.parseSettingsExport(json);assert.equal(parsed.hidePaidArticles,true);assert.equal(Object.hasOwn(parsed,'noteLogoBrowserBack'),false);
  assert.equal(Object.hasOwn(JSON.parse(core.exportSettings(parsed)).settings,'noteLogoBrowserBack'),false);
 }
 await f.save({hidePaidArticles:true});assert.equal(Object.hasOwn(f.data[core.settingsKey],'noteLogoBrowserBack'),false);
 await assert.rejects(f.save({noteLogoBrowserBack:true}));
});
