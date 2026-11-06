const { test } = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const backend = require('./helpers/chat.cjs'), { source } = backend;
const { documentFromHtml } = require('./helpers/dom.cjs');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
async function fixture(t, options = {}) {
  const f = backend({firefox:options.firefox}), c = f.context, requests = [], grants = [], events = new Map(), confirmations = [], copies = [];
  await f.save({ ollamaModel: 'local' });
  if (options.storedArticles) f.sessionData[f.context.OshaberiNoteArticles.key] = structuredClone(options.storedArticles);
  if (options.otherOwner) f.connect(options.otherOwner);
  if (options.storedChat) f.data[f.context.OshaberiNoteChatState.key] = structuredClone(options.storedChat);
  const document = documentFromHtml(source('home.html')), sessionValues = options.sessionValues ?? new Map();
  const timers = new Set();
  Object.assign(c, { document, location: { hash: options.hash ?? '', assign() {} }, AbortController, AbortSignal, TextDecoder,
    sessionStorage: { getItem:key=>sessionValues.get(key) ?? null,setItem:(key,value)=>sessionValues.set(key,value),removeItem:key=>sessionValues.delete(key) },
    navigator: { clipboard: { writeText: async text => { copies.push(text); await options.copyGate; if (options.copyError) throw new Error('clipboard denied'); } } },
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
  let websiteGranted = options.websiteConsent !== false;
  const contains = c.chrome.permissions.contains;
  c.chrome.permissions.contains = async permission => (await contains(permission)) && (!permission.data_collection?.includes('websiteContent') || websiteGranted);
  c.chrome.permissions.request = async permission => { grants.push(structuredClone(permission)); if (options.grant !== false && permission.data_collection?.includes('websiteContent')) websiteGranted = true; return options.grant !== false; };
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
  return { ...f, c, document, nodes: document.nodes, requests, grants, confirmations, copies, events, sessionValues };
}
async function articleTransfer() {
  const f=backend();f.connect('other');await f.save({ollamaModel:'local'});
  const normal=await f.chat('get');await f.chat('approve',{epoch:normal.epoch,endpoint:normal.endpoint});
  const article={articleId:'n123',title:'同じ題',author:'著者',body:'表示しない記事本文の秘密',url:'https://note.com/test/n/n123'};
  await f.send({type:'import-article',patch:{article,pageUrl:article.url}},{id:'test',url:article.url,frameId:0,tab:{id:7}});
  return {f,article,key:f.context.OshaberiNoteChatState.key,sessionKey:f.context.OshaberiNoteArticles.key,hash:f.opened[0].url.slice(f.opened[0].url.indexOf('#'))};
}

test('記事ページからの依頼を既存会話へ自動送信し、本文は隠して信頼できる記事参照だけをボタンにする',async t=>{
  const seed=await articleTransfer(),f=await fixture(t,{storedChat:seed.f.data[seed.key],storedArticles:seed.f.sessionData[seed.sessionKey],hash:seed.hash,reply:'記事の要約です。 [&偽の記事]'}),n=f.nodes;
  const posts=()=>f.requests.filter(item=>item.url.endsWith('/api/chat')).map(item=>JSON.parse(item.init.body));
  assert.equal(n.get('chat-actions').children[2].textContent,'記事について');assert.equal(n.get('chat-actions').children[2].getAttribute('aria-selected'),'true');
  assert.equal(posts().length,1);assert.equal(posts()[0].truncate,false);assert.equal(posts()[0].shift,false);
  assert.ok(posts()[0].messages.at(-1).content.includes(seed.article.body));assert.doesNotMatch(n.get('chat-messages').textContent,/表示しない記事本文の秘密/);
  const rows=n.get('chat-messages').querySelectorAll('article');
  assert.equal(rows[1].querySelector('button[aria-haspopup="dialog"]'),null);
  const reference=rows[0].querySelector('button[aria-haspopup="dialog"]');assert.equal(reference.textContent,'[&同じ題]');
  await reference.onclick();await flush();assert.equal(n.get('chat-article-dialog').open,true);
  n.get('chat-article-impression').onclick();await flush();assert.equal(n.get('chat-article-dialog').open,false);
  assert.equal(posts().length,2);assert.deepEqual(posts()[1].messages.map(item=>item.role),['system','user']);assert.equal(n.get('chat-messages').querySelectorAll('article').length,4);assert.match(posts()[1].messages.at(-1).content,/感想を聞かせて/);assert.ok(posts()[1].messages.at(-1).content.includes(seed.article.body));
  const replay=await fixture(t,{storedChat:f.data[seed.key],storedArticles:f.sessionData[seed.sessionKey],hash:seed.hash});
  assert.equal(replay.requests.filter(item=>item.url.endsWith('/api/chat')).length,0);assert.match(replay.nodes.get('chat-messages').textContent,/感想を聞かせて/);
  await n.get('chat-new').onclick();await flush();assert.deepEqual(f.sessionData[seed.sessionKey].articles,[]);assert.deepEqual(f.sessionData[seed.sessionKey].requests,{});
});

test('共有対象の変更を同期し、入力中や別タブに退避した下書きは確認するまで送らない',async t=>{
 const seed=await articleTransfer(),f=await fixture(t,{storedChat:seed.f.data[seed.key],storedArticles:seed.f.sessionData[seed.sessionKey],hash:seed.hash,reply:'Aの最初の回答'}),n=f.nodes;
 n.get('chat-input').value='Aについての下書き';n.get('chat-input').fire('input');
 await n.get('chat-actions').children[1].onclick();await flush();
 f.connect('other');const b={...seed.article,articleId:'n456',title:'別の記事B',body:'Bの本文の秘密',url:'https://note.com/test/n/n456'};
 f.c.chrome.tabs.get=async()=>({url:b.url});await f.send({type:'import-article',patch:{article:b,pageUrl:b.url}},{id:'test',url:b.url,frameId:0,tab:{id:9}});
 let state=await f.chat('get',{actionId:'article'});const token=f.opened.at(-1).url.split('=')[1];
 state=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'other',model:'local',text:'Bの依頼',requestToken:token});
 await f.chat('complete',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'other',model:'local',id:state.active.id,text:'Bの回答の秘密'});await flush();
 await n.get('chat-actions').children[2].onclick();await flush();assert.match(n.get('chat-article-target').textContent,/n456/);assert.equal(n.get('chat-input').value,'Aについての下書き');
 const beforePosts=f.requests.filter(r=>r.url.endsWith('/api/chat')).length;
 f.c.confirm=()=>false;n.get('chat-form').fire('submit');await flush();assert.equal(f.requests.filter(r=>r.url.endsWith('/api/chat')).length,beforePosts);assert.equal(n.get('chat-input').value,'Aについての下書き');
 f.c.confirm=text=>{assert.match(text,/会話区間が変更/);assert.match(text,/別の記事B/);return true;};n.get('chat-form').fire('submit');await flush();
 const posts=f.requests.filter(r=>r.url.endsWith('/api/chat')).map(r=>JSON.parse(r.init.body));assert.equal(posts.length,beforePosts+1);assert.ok(JSON.stringify(posts.at(-1).messages).includes(b.body));assert.ok(!JSON.stringify(posts.at(-1).messages).includes(seed.article.body));
 const reloaded=await fixture(t,{storedChat:f.data[seed.key],storedArticles:f.sessionData[seed.sessionKey],sessionValues:new Map([['oshaberiNote.articleContext.v1','old A selection']])});
 assert.match(reloaded.nodes.get('chat-article-target').textContent,/n456/);assert.equal(reloaded.sessionValues.get('oshaberiNote.articleContext.v1'),undefined);
 await reloaded.chat('reset',{actionId:'article'});await flush();assert.match(reloaded.nodes.get('chat-article-target').textContent,/未選択/);
});

test('送信直前の共有対象変更は背景で拒否し、下書きを保持して自動再送しない',async t=>{
 const seed=await articleTransfer(),f=await fixture(t,{storedChat:seed.f.data[seed.key],storedArticles:seed.f.sessionData[seed.sessionKey],hash:seed.hash}),n=f.nodes;
 f.connect('race-owner');const original=f.c.chrome.runtime.sendMessage;let changed=false;
 f.c.chrome.runtime.sendMessage=async message=>{
  if(!changed&&message.type==='chat-operation'&&message.operation==='start'&&message.patch.actionId==='article'){
   changed=true;const b={...seed.article,articleId:'nRaceB',title:'切替後B',body:'Bの本文',url:'https://note.com/test/n/nRaceB'};f.c.chrome.tabs.get=async()=>({url:b.url});
   await f.send({type:'import-article',patch:{article:b,pageUrl:b.url}},{id:'test',url:b.url,frameId:0,tab:{id:9}});
   let state=await f.chat('get',{actionId:'article'});state=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'race-owner',model:'local',text:'B',requestToken:f.opened.at(-1).url.split('=')[1]});
   await f.chat('complete',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'race-owner',model:'local',id:state.active.id,text:'Bの回答'});
  }
  return original(message);
 };
 n.get('chat-input').value='Aについての質問';n.get('chat-input').fire('input');n.get('chat-form').fire('submit');await flush();
 assert.equal(f.requests.filter(r=>r.url.endsWith('/api/chat')).length,1);assert.equal(n.get('chat-input').value,'Aについての質問');assert.match(n.get('chat-status').textContent,/対象区間.*変更/);assert.match(n.get('chat-article-target').textContent,/nRaceB/);assert.equal(n.get('chat-send').disabled,false);
 f.c.confirm=()=>false;n.get('chat-form').fire('submit');await flush();assert.equal(f.requests.filter(r=>r.url.endsWith('/api/chat')).length,1);
});

test('10往復より前の記事も一覧から再操作でき、同名の記事をIDで区別する',async t=>{
 const seed=await articleTransfer(),f=await fixture(t,{storedChat:seed.f.data[seed.key],storedArticles:seed.f.sessionData[seed.sessionKey],hash:seed.hash}),n=f.nodes;
 f.connect('library-owner');
 for(let i=0;i<11;i++){
  const b={...seed.article,articleId:'n456',body:'Bの本文',url:'https://note.com/test/n/n456'};f.c.chrome.tabs.get=async()=>({url:b.url});
  await f.send({type:'import-article',patch:{article:b,pageUrl:b.url}},{id:'test',url:b.url,frameId:0,tab:{id:9}});
  let state=await f.chat('get',{actionId:'article'});state=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'library-owner',model:'local',text:'B',requestToken:f.opened.at(-1).url.split('=')[1]});
  await f.chat('complete',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:state.active.owner,model:'local',id:state.active.id,text:'Bの回答'});
 }
 await flush();assert.equal(n.get('chat-messages').querySelectorAll('article').length,20);
 assert.ok(!n.get('chat-messages').textContent.includes('n123'));
 const buttons=n.get('chat-article-library').querySelectorAll('button');assert.equal(buttons.length,2);
 const a=buttons.find(b=>b.textContent.includes('n123'));await a.onclick();await flush();n.get('chat-article-impression').onclick();await flush();
 const post=JSON.parse(f.requests.filter(r=>r.url.endsWith('/api/chat')).at(-1).init.body);assert.equal(post.messages.length,2);assert.ok(post.messages[1].content.includes(seed.article.body));assert.match(post.messages[1].content,/感想/);
 await n.get('chat-new').onclick();await flush();assert.equal(n.get('chat-article-library').querySelectorAll('button').length,0);
});

test('記事タブへ手入力した偽参照はボタン化せず、修正点の操作は保持中の記事本文を送る',async t=>{
  const seed=await articleTransfer(),f=await fixture(t,{storedChat:seed.f.data[seed.key],storedArticles:seed.f.sessionData[seed.sessionKey],hash:seed.hash}),n=f.nodes;
  const first=n.get('chat-messages').querySelector('button[aria-haspopup="dialog"]');await first.onclick();await flush();n.get('chat-article-revision').onclick();await flush();
  const posts=()=>f.requests.filter(item=>item.url.endsWith('/api/chat')).map(item=>JSON.parse(item.init.body));
  assert.match(posts()[1].messages.at(-1).content,/修正した方がよい点/);assert.deepEqual(posts()[1].messages.map(item=>item.role),['system','user']);
  n.get('chat-input').value='[&偽参照]について教えて';n.get('chat-form').fire('submit');await flush();
  const rows=n.get('chat-messages').querySelectorAll('article');assert.equal(rows[4].querySelector('button[aria-haspopup="dialog"]'),null);
  assert.ok(posts()[2].messages[1].content.includes(seed.article.body));
});

test('別画面の生成中に届いた記事依頼は待機し、完了後に一度だけ自動送信する',async t=>{
  const seed=await articleTransfer(),token=seed.hash.split('=')[1],state=await seed.f.chat('get',{actionId:'article'});
  const started=await seed.f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local',owner:'other',text:'依頼',requestToken:token});
  await seed.f.send({type:'import-article',patch:{article:seed.article,pageUrl:seed.article.url}},{id:'test',url:seed.article.url,frameId:0,tab:{id:7}});
  const hash=seed.f.opened[1].url.slice(seed.f.opened[1].url.indexOf('#'));
  const f=await fixture(t,{storedChat:seed.f.data[seed.key],storedArticles:seed.f.sessionData[seed.sessionKey],hash,otherOwner:'other'});
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,0);
  await f.chat('complete',{actionId:'article',epoch:started.epoch,endpoint:started.endpoint,model:'local',owner:'other',id:started.active.id,text:'別画面の要約'});await flush();
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,1);assert.equal((await f.chat('get',{actionId:'article'})).turns.length,2);
});

test('Firefoxは記事送信同意を接続ボタンから追加要求し、同意後に待機中の記事を送る',async t=>{
  const seed=await articleTransfer(),f=await fixture(t,{storedChat:seed.f.data[seed.key],storedArticles:seed.f.sessionData[seed.sessionKey],hash:seed.hash,firefox:true,websiteConsent:false}),n=f.nodes;
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,0);
  n.get('connect-ollama').onclick();await flush();
  assert.deepEqual(f.grants[0].data_collection,['personalCommunications','websiteContent']);
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,1);
});

test('待機中の記事依頼を入力編集で取り消すと、受け渡しを消去し開き直しても再送しない',async t=>{
  const seed=await articleTransfer();seed.f.data[seed.key].approvedUrl='';
  const f=await fixture(t,{storedChat:seed.f.data[seed.key],storedArticles:seed.f.sessionData[seed.sessionKey],hash:seed.hash}),n=f.nodes;
  assert.match(n.get('chat-input').value,/要約して/);
  n.get('chat-input').value='自分で書いた質問';n.get('chat-input').fire('input');await flush();
  assert.deepEqual(f.sessionData[seed.sessionKey].requests,{});
  const replay=await fixture(t,{storedChat:f.data[seed.key],storedArticles:f.sessionData[seed.sessionKey],hash:seed.hash});
  assert.equal(replay.requests.filter(item=>item.url.endsWith('/api/chat')).length,0);
});

test('ホームはおしゃべり初期表示、歯車の#settingsは設定を表示し、初回に接続しない', async t => {
  for (const hash of ['', '#settings']) {
    const f = await fixture(t, { hash });
    assert.equal(f.nodes.get(hash ? 'panel-settings' : 'panel-chat').hidden, false);
    assert.equal(f.requests.length, 0); assert.equal(f.grants.length, 0);
    assert.equal(f.nodes.has('operation-mode'), false);
    assert.equal(f.nodes.has('note-logo-browser-back'), false);
  }
});
test('開き直すと最後の会話タブと履歴を復元し、初回質問を再送しない',async t=>{
  const f=await fixture(t,{reply:'保存されたタグ回答'}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();await n.get('chat-actions').children[1].onclick();await flush();
  n.get('chat-input').value='保存しない下書き';
  const key=f.c.OshaberiNoteChatState.key,reopened=await fixture(t,{storedChat:f.data[key]}),r=reopened.nodes;
  assert.equal(r.get('chat-actions').children[1].getAttribute('aria-selected'),'true');
  assert.match(r.get('chat-heading').textContent,/タグの提案/);assert.match(r.get('chat-messages').textContent,/保存されたタグ回答/);
  assert.equal(r.get('chat-input').value,'');assert.equal(reopened.requests.filter(item=>item.url.endsWith('/api/chat')).length,0);
  reopened.connect('other-page');await reopened.chat('select',{actionId:'chat',owner:'other-page'});await flush();
  assert.equal(r.get('chat-actions').children[1].getAttribute('aria-selected'),'true');
  const normal=await fixture(t,{storedChat:reopened.data[key]});
  assert.equal(normal.nodes.get('chat-actions').children[0].getAttribute('aria-selected'),'true');
  assert.equal(normal.requests.filter(item=>item.url.endsWith('/api/chat')).length,0);
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
  assert.match(n.get('ollama-origin-command').value, /\n\$env:OLLAMA_CONTEXT_LENGTH = '16384'\nollama serve$/);
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
test('前後の発言へ自分・AIの順で移動し、手動スクロール後も現在位置から移動する',async t=>{
  const f=await fixture(t),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();
  for(const text of ['最初の質問','次の質問']){n.get('chat-input').value=text;n.get('chat-form').fire('submit');await flush();}
  const container=n.get('chat-messages'),rows=container.querySelectorAll('article'),previous=n.get('chat-previous-message'),next=n.get('chat-next-message');
  container.clientHeight=200;container.scrollHeight=580;container.scrollTop=0;container.getBoundingClientRect=()=>({top:50});
  rows.forEach((row,index)=>{row.getBoundingClientRect=()=>({top:50+index*120-container.scrollTop,height:100});});
  container.fire('scroll');assert.equal(previous.disabled,true);assert.equal(next.disabled,false);
  for(const top of [120,240,360]){next.onclick();assert.equal(container.scrollTop,top);}
  assert.equal(next.disabled,true);assert.match(n.get('chat-message-position').textContent,/4 \/ 4/);
  assert.match(container.children.at(-1).getAttribute('style'),/height: 100px/);
  previous.onclick();assert.equal(container.scrollTop,240);
  container.scrollTop=180;container.fire('scroll');previous.onclick();assert.equal(container.scrollTop,120);
  container.scrollTop=180;container.fire('scroll');next.onclick();assert.equal(container.scrollTop,240);
  assert.equal(f.requests.filter(item=>item.url.endsWith('/api/chat')).length,2);
  assert.equal((await f.chat('get')).turns.length,2);
  await n.get('chat-new').onclick();await flush();assert.equal(previous.disabled,true);assert.equal(next.disabled,true);assert.equal(n.get('chat-message-position').textContent,'発言なし');
});

test('初回2/2が収まる間は余白とスクロール書込を作らず、次の往復から末尾へ移動する',async t=>{
  let finish,count=0;const encoder=new TextEncoder();
  const f=await fixture(t,{stream:()=>++count===1?new Response(new ReadableStream({start(controller){
    controller.enqueue(encoder.encode(JSON.stringify({message:{role:'assistant',content:'短い回答'},done:false})+'\n'));
    finish=()=>{controller.enqueue(encoder.encode(JSON.stringify({message:{role:'assistant',content:'です'},done:true})+'\n'));controller.close();};
  }})):new Response(JSON.stringify({message:{role:'assistant',content:'次の回答'},done:true})+'\n')}),n=f.nodes,container=n.get('chat-messages'),create=f.document.createElement.bind(f.document);
  container.clientHeight=300;container.getBoundingClientRect=()=>({top:0});
  const writes=[];let top=0;Object.defineProperty(container,'scrollTop',{get:()=>top,set:value=>{writes.push(value);top=Math.max(0,Math.min(value,container.scrollHeight-container.clientHeight));}});
  Object.defineProperty(container,'scrollHeight',{get:()=>Math.max(300,container.querySelectorAll('article').length*80+Number(/height: ([\d.]+)/.exec(container.children.at(-1)?.getAttribute('style')||'')?.[1]||0))});
  f.document.createElement=tag=>{const node=create(tag);if(tag==='article')node.getBoundingClientRect=()=>({top:container.querySelectorAll('article').indexOf(node)*80-top,height:60});return node;};
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='初回';n.get('chat-form').fire('submit');await flush();
  for(let i=0;i<3;i++){container.fire('scroll');f.events.get('resize')();}
  assert.deepEqual(writes,[]);assert.equal(n.get('chat-message-position').textContent,'2 / 2 発言');
  assert.equal(n.get('chat-next-message').disabled,true);assert.equal(container.querySelector('div[aria-hidden="true"]'),null);
  finish();await flush();assert.deepEqual(writes,[]);
  n.get('chat-input').value='次の質問';n.get('chat-form').fire('submit');await flush();
  assert.ok(writes.length>0);assert.ok(top>0);assert.equal(n.get('chat-message-position').textContent,'4 / 4 発言');
});

test('初回2/2でも長文で実際のスクロールが必要なら末尾追従する',async t=>{
  const f=await fixture(t,{reply:'長'.repeat(500)}),n=f.nodes,container=n.get('chat-messages'),create=f.document.createElement.bind(f.document);
  container.clientHeight=200;container.getBoundingClientRect=()=>({top:0});
  Object.defineProperty(container,'scrollHeight',{get:()=>container.textContent.includes('長'.repeat(500))?680:200});
  let top=0;Object.defineProperty(container,'scrollTop',{get:()=>top,set:value=>{top=Math.max(0,Math.min(value,container.scrollHeight-200));}});
  f.document.createElement=tag=>{const node=create(tag);if(tag==='article')node.getBoundingClientRect=()=>({top:container.querySelectorAll('article').indexOf(node)*80-top,height:60});return node;};
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='長文の確認';n.get('chat-form').fire('submit');await flush();
  assert.equal(top,480);assert.equal(n.get('chat-message-position').textContent,'2 / 2 発言');assert.equal(container.querySelector('div[aria-hidden="true"]'),null);
});

test('過去を閲覧中でも自分の送信受付後は最終発言へ移動し、入力中や送信拒否時は位置を保つ',async t=>{
  const f=await fixture(t),n=f.nodes,container=n.get('chat-messages'),create=f.document.createElement.bind(f.document);
  container.clientHeight=200;container.getBoundingClientRect=()=>({top:0});
  Object.defineProperty(container,'scrollHeight',{get:()=>Math.max(200,container.querySelectorAll('article').length*80+120)});
  let top=0;Object.defineProperty(container,'scrollTop',{get:()=>top,set:value=>{top=Math.max(0,Math.min(value,container.scrollHeight-container.clientHeight));}});
  f.document.createElement=tag=>{const node=create(tag);if(tag==='article')node.getBoundingClientRect=()=>({top:container.querySelectorAll('article').indexOf(node)*80-container.scrollTop,height:60});return node;};
  n.get('connect-ollama').onclick();await flush();
  for(const text of ['最初','2回目']){n.get('chat-input').value=text;n.get('chat-form').fire('submit');await flush();}
  n.get('chat-previous-message').onclick();assert.equal(container.scrollTop,160);
  n.get('chat-input').value='下書き';n.get('chat-input').fire('input');await flush();assert.equal(container.scrollTop,160);
  n.get('chat-input').value=' ';n.get('chat-form').fire('submit');await flush();assert.equal(container.scrollTop,160);
  n.get('chat-input').value='3回目';n.get('chat-form').fire('submit');await flush();
  assert.equal(container.scrollTop,400);assert.equal(n.get('chat-message-position').textContent,'6 / 6 発言');
  assert.equal(n.get('chat-next-message').disabled,true);assert.equal(f.document.activeElement,n.get('chat-input'));
});

test('前の発言を読んでいる間は生成更新・完了で末尾へ引き戻さない',async t=>{
  let finish;const encoder=new TextEncoder();
  const f=await fixture(t,{stream:()=>new Response(new ReadableStream({start(controller){
    controller.enqueue(encoder.encode(JSON.stringify({message:{role:'assistant',content:'生成途中'},done:false})+'\n'));
    finish=()=>{controller.enqueue(encoder.encode(JSON.stringify({message:{role:'assistant',content:'完了'},done:true})+'\n'));controller.close();};
  }}))}),n=f.nodes,container=n.get('chat-messages'),create=f.document.createElement.bind(f.document);
  container.clientHeight=200;container.scrollHeight=280;container.getBoundingClientRect=()=>({top:0});
  f.document.createElement=tag=>{const node=create(tag);if(tag==='article')node.getBoundingClientRect=()=>({top:container.querySelectorAll('article').indexOf(node)*80-(container.scrollTop||0),height:60});return node;};
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='質問';n.get('chat-form').fire('submit');await flush();
  container.scrollTop=80;container.fire('scroll');n.get('chat-previous-message').onclick();assert.equal(container.scrollTop,0);
  finish();await flush();assert.equal(container.scrollTop,0);assert.match(n.get('chat-status').textContent,/完了/);
});

test('AI回答の箇条書きと入れ子を太字・タグ操作と併用し、保存とコピーは原文のまま保つ',async t=>{
  const reply='**要点整理**\r\n\r\n* **評価軸:** 読者の視点\r\n* **具体的確認事項:**\r\n    * AI利用\r\n        * **方法** [#AI]\r\n    * 基準 <img src=x onerror=alert(1)>\r\n* **運営:** 期待\r\n\r\n最後の段落';
  const f=await fixture(t,{reply}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='* 自分の箇条書き';n.get('chat-form').fire('submit');await flush();
  const rows=n.get('chat-messages').children,body=rows[1].querySelector('[data-chat-body]');
  assert.equal(rows[0].querySelector('ul'),null);assert.equal(body.querySelectorAll('ul').length,3);assert.equal(body.querySelectorAll('li').length,6);
  const root=body.children.find(node=>node.tagName==='UL');assert.equal(root.children.length,3);
  assert.equal(root.children[1].querySelector('ul').children.length,2);
  assert.ok(body.querySelectorAll('ul').every(node=>node.parentElement.tagName!=='P'));
  assert.equal(body.children.at(-1).textContent,'最後の段落');assert.equal(body.querySelector('img'),null);
  assert.ok(body.querySelectorAll('strong').some(node=>node.textContent==='具体的確認事項:'));
  body.querySelector('button[aria-haspopup="dialog"]').onclick();assert.equal(n.get('chat-tag-heading').textContent,'#AI');
  await rows[1].querySelector('button[aria-label="AIの回答をコピー"]').onclick();assert.deepEqual(f.copies,[reply]);
  assert.equal((await f.chat('get')).turns[0].assistant,reply);
});

test('リストの継続行と空行後の同階層項目を扱い、星印の普通の文章は保持する',async t=>{
  const reply='導入の文章\n* 親\n  続きの行\n\n* 次の項目\n終了の文章\n*空白なしは普通の文章';
  const f=await fixture(t,{reply}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='確認';n.get('chat-form').fire('submit');await flush();
  const body=n.get('chat-messages').children[1].querySelector('[data-chat-body]');
  assert.equal(body.querySelectorAll('ul').length,1);assert.equal(body.querySelectorAll('li').length,2);
  assert.equal(body.querySelector('li').textContent,'親\n続きの行');
  assert.equal(body.children.at(-1).textContent,'終了の文章\n*空白なしは普通の文章');
});

test('リストと太字で本文を分割してもタグ操作は回答全体で最大100個に制限する',async t=>{
  const reply='* **[#同じタグ]**\n'.repeat(101),f=await fixture(t,{reply}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='確認';n.get('chat-form').fire('submit');await flush();
  const body=n.get('chat-messages').children[1].querySelector('[data-chat-body]');
  assert.equal(body.querySelectorAll('li').length,101);assert.equal(body.querySelectorAll('button[aria-haspopup="dialog"]').length,100);
  assert.equal((await f.chat('get')).turns[0].assistant,reply);
});

test('完了したAI回答の太字とタグ操作を両立し、保存・コピーはMarkdown原文を保持する',async t=>{
  const reply='**要点整理**\n\n* **評価軸の重要性:** 内容。\n**おすすめ [#読書]**\n**<img src=x onerror=alert(1)>**';
  const f=await fixture(t,{reply}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='**自分の文章**';n.get('chat-form').fire('submit');await flush();
  const rows=n.get('chat-messages').children,body=rows[1].querySelector('[data-chat-body]');
  assert.deepEqual(body.querySelectorAll('strong').map(node=>node.textContent),['要点整理','評価軸の重要性:','おすすめ [#読書]','<img src=x onerror=alert(1)>']);
  assert.equal(body.querySelector('img'),null);assert.equal(rows[0].querySelector('strong'),null);
  assert.equal(rows[0].querySelector('[data-chat-body]').textContent,'**自分の文章**');
  body.querySelector('button[aria-haspopup="dialog"]').onclick();assert.equal(n.get('chat-tag-dialog').open,true);
  assert.equal(n.get('chat-tag-heading').textContent,'#読書');
  await rows[1].querySelector('button[aria-label="AIの回答をコピー"]').onclick();
  assert.deepEqual(f.copies,[reply]);assert.equal((await f.chat('get')).turns[0].assistant,reply);
});

test('閉じていない太字・改行をまたぐ強調・タグ名の中の星印は原文で残す',async t=>{
  const reply='未完了 **見出し\n**行を\nまたぐ**\n[#a**b**]';
  const f=await fixture(t,{reply}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='確認';n.get('chat-form').fire('submit');await flush();
  const body=n.get('chat-messages').children[1].querySelector('[data-chat-body]');
  assert.equal(body.querySelectorAll('strong').length,0);assert.equal(body.textContent,reply);
  assert.equal(body.querySelector('button[aria-haspopup="dialog"]').textContent,'[#a**b**]');
});

test('自分の発言とAI回答は表示装飾を含めず、改行・タグ・HTML文字列を原文のままコピーする',async t=>{
  const user='  自分の文章\n改行と余白  ',reply='回答\n[#読書] <script>文字列</script>';
  const f=await fixture(t,{reply}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value=user;n.get('chat-form').fire('submit');await flush();
  assert.deepEqual(f.copies,[]);
  const rows=n.get('chat-messages').children;
  await rows[0].querySelector('button[aria-label="自分の発言をコピー"]').onclick();
  await rows[1].querySelector('button[aria-label="AIの回答をコピー"]').onclick();
  assert.deepEqual(f.copies,[user,reply]);assert.match(rows[1].textContent,/コピーしました/);
  assert.equal((await f.chat('get')).turns[0].assistant,reply);
  assert.equal(n.get('chat-tag-dialog').open,undefined);
});

test('コピー中の連打を止め、失敗を表示して会話と再試行を保つ',async t=>{
  let release;const copyGate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{copyGate,copyError:true}),n=f.nodes;
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='保持する発言';n.get('chat-form').fire('submit');await flush();
  const button=n.get('chat-messages').querySelector('button[aria-label="自分の発言をコピー"]');
  const pending=button.onclick();button.onclick();assert.equal(f.copies.length,1);assert.equal(button.disabled,true);
  release();await pending;assert.equal(button.disabled,false);assert.match(n.get('chat-messages').textContent,/コピーできませんでした/);
  assert.equal((await f.chat('get')).turns[0].user,'保持する発言');assert.equal(n.get('chat-send').disabled,false);
});

test('完了したAI回答のタグだけをボタン化し、検索と実際の4グループを選べる',async t=>{
  const reply='1. [#週末の過ごし方]：週末の案です。\n2. [#a/b? x]：別の案。';
  const f=await fixture(t,{reply}),n=f.nodes;
  await f.c.OshaberiNotePlatform.tag({type:'RENAME_TAG_GROUP',groupId:'group2',name:'読み物',expectedName:''});await flush();
  n.get('connect-ollama').onclick();await flush();n.get('chat-input').value='[#ユーザーの入力]';n.get('chat-form').fire('submit');await flush();
  const rows=n.get('chat-messages').children,buttons=rows[1].querySelectorAll('button[aria-haspopup="dialog"]');
  assert.equal(rows[0].querySelectorAll('button[aria-haspopup="dialog"]').length,0);assert.equal(buttons.length,2);
  assert.equal(rows[1].querySelector('[data-chat-body]').textContent,reply);assert.equal((await f.chat('get')).turns[0].assistant,reply);
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
  assert.equal(n.get('chat-messages').querySelectorAll('button[aria-haspopup="dialog"]').length,0);
  await n.get('chat-stop').onclick();await flush();assert.equal(n.get('chat-messages').querySelectorAll('button[aria-haspopup="dialog"]').length,0);
  const html=await fixture(t,{reply:'<img src=x onerror=alert(1)> [#<script>]'}),h=html.nodes;
  h.get('connect-ollama').onclick();await flush();h.get('chat-input').value='hi';h.get('chat-form').fire('submit');await flush();
  assert.equal(h.get('chat-messages').querySelector('img'),null);assert.equal(h.get('chat-messages').querySelector('script'),null);
  assert.equal(h.get('chat-messages').querySelector('button[aria-haspopup="dialog"]').textContent,'[#<script>]');
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
  n.get('chat-messages').querySelector('button[aria-haspopup="dialog"]').onclick();const button=n.get('chat-tag-groups').children[0];
  button.onclick();button.onclick();assert.equal(button.disabled,true);release();await flush();assert.deepEqual((await f.settings()).tagGroups[0].tags,['tag']);
  const uncertain=await fixture(t,{reply:'[#tag]',tagError:true}),u=uncertain.nodes;
  u.get('connect-ollama').onclick();await flush();u.get('chat-input').value='hi';u.get('chat-form').fire('submit');await flush();
  u.get('chat-messages').querySelector('button[aria-haspopup="dialog"]').onclick();u.get('chat-tag-groups').children[0].onclick();await flush();
  assert.match(u.get('chat-tag-status').textContent,/自動再送は行いません/);assert.equal(u.get('chat-tag-groups').children[1].disabled,true);
  assert.deepEqual((await uncertain.settings()).tagGroups[0].tags,[]);
});
