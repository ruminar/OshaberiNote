const {test}=require('node:test'),assert=require('node:assert/strict');
const backend=require('./helpers/chat.cjs'),{documentFromHtml}=require('./helpers/dom.cjs');
const article=(articleId='n123',title='同じタイトル',body='これは表示できる記事の本文です。')=>({articleId,title,author:'著者',body,url:`https://note.com/test/n/${articleId}`});
function articleCopyUi(options={}) {
 const f=backend(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time id="published" datetime="2026-10-07T23:30:00-05:00"></time></div><div id="note-body" data-name="body"><p id="text"></p><p><a href="https://example.com/source" id="link"></a></p><p hidden id="hidden"></p><time datetime="2000-01-01"></time></div></div></article>');
 doc.body=doc.root;for(const [id,text] of [['title','記事の題'],['author','著者'],['text','コピーする本文'],['link','参照先'],['hidden','非表示の秘密']])doc.getElementById(id).textContent=text;
 doc.getElementById('note-article').getBoundingClientRect=()=>({left:240,width:700});
 const win={matchMedia:()=>({matches:true}),getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'})};
 const copies=[],dates=[],imports=[];require('node:vm').runInContext(require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/note-ui.js'),'utf8'),f.context);
 const ui=f.context.OshaberiNoteUi.create(doc,win,{summarizeArticle:async value=>imports.push(value),copyArticle:async (value,date)=>{if(options.fail)throw Error('clipboard denied');copies.push(value.body);dates.push(date);},...(options.loadAdjacent?{loadArticleAdjacent:options.loadAdjacent}:{})});
 const update=url=>ui.update(f.context.OshaberiNote.defaultSettings(),url||article().url);update();
 const wrapper=doc.querySelectorAll('div').find(n=>n.className==='oshaberi-note-article-summary');
 return {f,doc,win,copies,dates,imports,update,wrapper,controller:ui,buttons:wrapper.querySelectorAll('button'),status:wrapper.querySelector('span')};
}

function appendAdjacent(f, label, href, title='前後の記事', host=f.doc.body) {
 const fragment=documentFromHtml('<div class="flex"><div class="relative flex min-w-0 basis-1/2 items-center gap-2 py-4"><a class="absolute inset-0" target="_self"></a><div class="min-w-0"><p></p><p></p></div></div></div>');
 const root=fragment.root.children[0],card=root.children[0],link=card.querySelector('a'),ps=card.querySelectorAll('p');
 ps[0].textContent=label;ps[1].textContent=title;link.setAttribute('href',href);link.setAttribute('title',title);link.setAttribute('aria-label',title);host.append(root);
 return {root,card,link};
}

test('記事末尾の前後リンクを要約ボタンの上へ配置し、遅延出現・片側なしを反映する',()=>{
 const f=articleCopyUi(),links=f.wrapper.querySelectorAll('a[data-oshaberi-note-adjacent]');
 assert.deepEqual(f.wrapper.children.slice(0,4).map(n=>n.textContent),['◀ 前の記事','次の記事 ▶','この記事を要約','記事全文を取得']);
 assert.ok(links.every(n=>!n.hasAttribute('href')&&n.getAttribute('aria-disabled')==='true'));
 const prev=appendAdjacent(f,'前の記事','/test/n/n111','以前の記事'),next=appendAdjacent(f,'次の記事','https://note.com/test/n/n222','以降の記事');f.update();
 assert.equal(links[0].href,'https://note.com/test/n/n111');assert.equal(links[1].href,'https://note.com/test/n/n222');assert.equal(links[0].getAttribute('target'),'_self');assert.equal(links[0].getAttribute('title'),'以前の記事');assert.ok(!links[0].hasAttribute('aria-disabled'));
 const event=links[0].fire('click',{ctrlKey:true});assert.ok(!event.defaultPrevented);
 prev.root.remove();f.update();assert.ok(!links[0].hasAttribute('href'));assert.equal(links[1].href,'https://note.com/test/n/n222');
 next.link.setAttribute('href','https://evil.test/test/n/n222');const stale=links[1].fire('click');assert.equal(stale.defaultPrevented,true);assert.ok(!links[1].hasAttribute('href'));
 assert.deepEqual(f.imports,[]);assert.deepEqual(f.copies,[]);
});

test('前後記事は本文内・外部・別記事の古い枠・重複・未知構造を採用せずSPA遷移でも消去する',()=>{
 const f=articleCopyUi(),previous=f.wrapper.querySelectorAll('a[data-oshaberi-note-adjacent]')[0];
 appendAdjacent(f,'前の記事','/test/n/n111','本文中の偽リンク',f.doc.getElementById('note-body'));f.update();assert.ok(!previous.hasAttribute('href'));
 const source=appendAdjacent(f,'前の記事','https://evil.test/test/n/n111');f.update();assert.ok(!previous.hasAttribute('href'));
 source.link.setAttribute('href','/test/n/n111');source.card.hidden=true;f.update();assert.ok(!previous.hasAttribute('href'));source.card.hidden=false;
 source.link.setAttribute('aria-label','不一致');f.update();assert.ok(!previous.hasAttribute('href'));source.link.setAttribute('aria-label','前後の記事');
 source.root.setAttribute('data-note-key','nOld');f.update();assert.ok(!previous.hasAttribute('href'));source.root.removeAttribute('data-note-key');
 f.update();assert.equal(previous.href,'https://note.com/test/n/n111');
 const duplicate=appendAdjacent(f,'前の記事','/test/n/n333');f.update();assert.ok(!previous.hasAttribute('href'));duplicate.root.remove();f.update();
 f.update(article('n456').url);assert.ok(!previous.hasAttribute('href'));
 f.update();assert.equal(previous.href,'https://note.com/test/n/n111');
 source.card.classList.remove('basis-1/2');f.update();assert.ok(!previous.hasAttribute('href'));
});

test('前後記事はスクロールせず一度だけ取得し、DOMの公式リンクを優先して再描画で再送しない',async()=>{
 const calls=[],f=articleCopyUi({loadAdjacent:async url=>{calls.push(url);return {previous:{url:'https://note.com/test/n/n111',title:'APIの前記事'},next:{url:'https://note.com/test/n/n222',title:'APIの次記事'}};}});
 await new Promise(r=>setImmediate(r));const links=f.wrapper.querySelectorAll('a[data-oshaberi-note-adjacent]');
 assert.equal(calls.length,1);assert.equal(links[0].href,'https://note.com/test/n/n111');assert.equal(links[1].href,'https://note.com/test/n/n222');assert.ok(!links[0].fire('click').defaultPrevented);
 for(let i=0;i<3;i++)f.update();await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);
 appendAdjacent(f,'前の記事','/test/n/n333','公式DOMの前記事');f.update();assert.equal(links[0].href,'https://note.com/test/n/n333');assert.deepEqual(f.imports,[]);assert.equal(f.f.articleData.current,undefined);
});

test('前後記事の取得失敗は再送せず、遷移前の遅い応答を別記事へ適用しない',async()=>{
 const pending=[],f=articleCopyUi({loadAdjacent:url=>new Promise((resolve,reject)=>pending.push({url,resolve,reject}))});await new Promise(r=>setImmediate(r));
 const links=f.wrapper.querySelectorAll('a[data-oshaberi-note-adjacent]');
 f.doc.querySelector('[data-note-key]').setAttribute('data-note-key','n456');f.update(article('n456').url);await new Promise(r=>setImmediate(r));assert.equal(pending.length,2);
 pending[0].resolve({previous:{url:'https://note.com/test/n/nOld',title:'古い記事の結果'}});await new Promise(r=>setImmediate(r));assert.ok(!links[0].hasAttribute('href'));
 pending[1].reject(Error('HTTP 500'));await new Promise(r=>setImmediate(r));assert.match(links[0].getAttribute('title'),/取得できませんでした/);f.update(article('n456').url);await new Promise(r=>setImmediate(r));assert.equal(pending.length,2);
});

test('前後記事APIは固定したnoteのGETだけを使い、前後の公開記事名とURLだけを返す',async()=>{
 const f=backend(),api=f.context.OshaberiNoteArticles,calls=[];
 const note=(key,name)=>({key,name,status:'published',user:{urlname:'test'},custom_domain:null,body:'送らない本文'});
 const value=await api.adjacent(article().url+'?magazine_key=mSeries#anchor',async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({data:{prev_note:note('n111','前記事'),next_note:note('n222','次記事'),comments:['保存しないコメント']}})};});
 assert.equal(calls[0].url,'https://note.com/api/v3/notes/n123/extra_items?magazine_key=mSeries');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');
 assert.deepEqual(JSON.parse(JSON.stringify(value)),{previous:{url:'https://note.com/test/n/n111?magazine_key=mSeries',title:'前記事'},next:{url:'https://note.com/test/n/n222?magazine_key=mSeries',title:'次記事'}});
 await assert.rejects(api.adjacent('https://evil.test/test/n/n123',()=>assert.fail('外部URLには送信しない')));
 await assert.rejects(api.adjacent(article().url+'?magazine_key=invalid',()=>assert.fail('不正なマガジンでは送信しない')));
});

test('前後記事APIは失敗や不正応答を拒否し、下書き・外部ドメイン・不正ID・自記事を候補にしない',async()=>{
 const api=backend().context.OshaberiNoteArticles;
 await assert.rejects(api.adjacent(article().url,async()=>({ok:false})),/取得できません/);
 await assert.rejects(api.adjacent(article().url,async()=>({ok:true,json:async()=>({data:[]})})),/確認できません/);
 const base={key:'n111',name:'前記事',status:'published',user:{urlname:'test'},custom_domain:null};
 for(const bad of [{...base,status:'draft'},{...base,custom_domain:'outside.test'},{...base,key:'../bad'},{...base,user:{urlname:'settings'}},{...base,key:'n123'}]){
  const result=await api.adjacent(article().url,async()=>({ok:true,json:async()=>({data:{prev_note:bad,next_note:null}})}));assert.deepEqual(JSON.parse(JSON.stringify(result)),{});
 }
});

test('記事全文取得は要約と同じリンク付き本文だけをコピーし、送信や保存をしない',async()=>{
 const f=articleCopyUi();assert.deepEqual(f.buttons.map(n=>n.textContent),['この記事を要約','記事全文を取得']);
 const expected=f.f.context.OshaberiNoteArticles.extract(f.doc,f.win,article().url).body;
 await f.buttons[1].onclick();assert.deepEqual(f.copies,[expected]);assert.match(expected,/https:\/\/example.com\/source/);assert.ok(!expected.includes('非表示の秘密'));assert.ok(!expected.includes('記事の題'));
 assert.deepEqual(f.imports,[]);assert.equal(f.f.articleData.current,undefined);assert.match(f.status.textContent,/コピーしました/);
 await f.buttons[0].onclick();assert.equal(f.imports[0].body,expected);
});

test('投稿日は本文外の表示中timeから取得し、元の暦日を維持、不明・曖昧・不正日は推測しない',async()=>{
 const f=articleCopyUi(),time=f.doc.getElementById('published');
 await f.buttons[1].onclick();assert.equal(f.dates.at(-1),'2026-10-07');
 for(const value of ['', '2026-10-XX','2026-02-30T00:00:00+09:00']){time.setAttribute('datetime',value);await f.buttons[1].onclick();assert.equal(f.dates.at(-1),'');}
 time.setAttribute('datetime','2026-10-07');time.hidden=true;await f.buttons[1].onclick();assert.equal(f.dates.at(-1),'');
 time.hidden=false;const updated=f.doc.createElement('time');updated.setAttribute('datetime','2026-10-08');time.parentElement.append(updated);await f.buttons[1].onclick();assert.equal(f.dates.at(-1),'');
});

test('記事全文取得はURLとDOMの不一致を拒否し、コピー失敗後にも再試行できる',async()=>{
 const options={fail:true},f=articleCopyUi(options);
 await f.buttons[1].onclick();assert.match(f.status.textContent,/コピーに失敗/);assert.equal(f.buttons[1].disabled,false);
 options.fail=false;f.update(article('n456').url);await f.buttons[1].onclick();assert.match(f.status.textContent,/本文と記事URL/);assert.equal(f.copies.length,0);
 f.update();await f.buttons[1].onclick();assert.equal(f.copies.length,1);assert.deepEqual(f.imports,[]);
});
async function ready(){const f=backend();f.connect('owner');await f.save({ollamaModel:'local-model'});const state=await f.chat('get');await f.chat('approve',{epoch:state.epoch,endpoint:state.endpoint});return f;}
async function importArticle(f,value=article()){
 f.context.chrome.tabs.get=async()=>({url:value.url,windowId:3,index:4});
 await f.send({type:'import-article',patch:{article:value,pageUrl:value.url}},{id:'test',url:value.url,frameId:0,tab:{id:7}});
 return f.opened.at(-1).url.split('#article-request=')[1];
}
async function start(f,token,owner='owner') {const state=await f.chat('get',{actionId:'article'});return f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner,model:'local-model',text:'表示する依頼',requestToken:token});}
async function complete(f,state,text='回答'){return f.chat('complete',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:state.active.owner,model:'local-model',id:state.active.id,text});}

test('記事を専用の永続領域に保持し、表示文・送信本文・記事参照を分離する',async()=>{
 const f=await ready(),value=article(),token=await importArticle(f,value),state=await start(f,token);
 assert.equal(state.turns[0].user,'[&同じタイトル]について要約して');assert.equal(state.turns[0].articleId,'n123');
 assert.match(state.messages.at(-1).content,/下記の文章を、極力意味を失わないように要約/);assert.ok(state.messages.at(-1).content.includes(value.body));
 assert.equal(state.messages[0].role,'system');assert.match(state.messages[0].content,/資料/);
 assert.equal(f.articleData.current.articles[0].body,value.body);
 assert.equal(f.data[f.context.OshaberiNoteChatState.key].conversations.article,undefined);
 assert.ok(!JSON.stringify(f.data).includes(value.body));
 assert.ok(!f.context.OshaberiNote.exportSettings(await f.settings()).includes(value.body));
 assert.ok(!f.opened[0].url.includes(value.title));assert.ok(!f.opened[0].url.includes(value.body));
});

test('受け渡しは生成開始の保存と同時に一度だけ消費し、並行要求と再読み込みで再送しない',async()=>{
 const f=await ready(),token=await importArticle(f),results=await Promise.allSettled([start(f,token),start(f,token)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const current=results.find(r=>r.status==='fulfilled').value;await complete(f,current);
 await assert.rejects(start(f,token),/処理済み/);
 assert.deepEqual(f.articleData.current.requests,{});
 assert.equal((await f.chat('get',{actionId:'article'})).turns.length,1);
});

test('同名の記事A/Bでも本文は対象だけに限定し、感想だけ同じ著者の他記事要約を使う',async()=>{
 const f=await ready(),a=article('n123','同名','記事Aの本文'),b=article('n456','同名','記事Bの本文');
 await complete(f,await start(f,await importArticle(f,a)),'Aの要約');await complete(f,await start(f,await importArticle(f,b)),'Bの要約');
 let state=await f.chat('get',{actionId:'article'});
 state=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text:'感想',articleId:a.articleId,articleAction:'impression'});
 assert.ok(state.messages.at(-1).content.includes(a.body));assert.ok(!state.messages.at(-1).content.includes(b.body));assert.match(state.messages.at(-1).content,/感想/);
 assert.ok(state.messages[1].content.includes('Bの要約'));assert.deepEqual(state.messages.map(m=>m.role),['system','user']);assert.ok(state.messages.every(m=>!m.content.includes(b.body)&&!m.content.includes('Aの要約')&&!m.content.includes('[&同名]')));
 await complete(f,state);state=await f.chat('get',{actionId:'article'});
 const follow=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text:'根拠を詳しく',articleSegmentId:state.turns.at(-1).articleSegmentId});
 assert.ok(follow.messages[1].content.includes(a.body));assert.equal(follow.turns.at(-1).user,'根拠を詳しく');
 assert.deepEqual(follow.messages.map(m=>m.role),['system','user','assistant','user']);assert.ok(follow.messages.every(m=>!m.content.includes(b.body)&&!m.content.includes('Aの要約')));
 await complete(f,follow,'自由質問の回答');state=await f.chat('get',{actionId:'article'});
 const revised=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text:'修正点',articleId:a.articleId,articleAction:'revision'});
 assert.deepEqual(revised.messages.map(m=>m.role),['system','user']);assert.match(revised.messages[1].content,/修正した方がよい点/);assert.ok(revised.messages[1].content.includes(a.body));assert.ok(revised.messages.every(m=>!m.content.includes(b.body)&&!m.content.includes('自由質問の回答')));
 const session=f.articleData.current;assert.equal(session.conversation.turns.length,5);
 assert.ok(session.conversation.turns.every(turn=>!Object.hasOwn(turn,'llmText')));
 assert.ok(!JSON.stringify(session.conversation).includes(a.body));assert.ok(!JSON.stringify(session.conversation).includes(b.body));
 assert.equal(JSON.stringify(session).split(a.body).length-1,1);assert.equal(JSON.stringify(session).split(b.body).length-1,1);

});

test('記事の初期化は本文と履歴を消し、ブラウザ再起動では双方と通常会話を残す',async()=>{
 const f=await ready(),normal=await f.chat('get'),patch={epoch:normal.epoch,endpoint:normal.endpoint,owner:'owner',model:'local-model'};
 const n=await f.chat('start',{...patch,text:'通常は残す'});await f.chat('complete',{...patch,id:n.active.id,text:'通常回答'});
 const token=await importArticle(f);await complete(f,await start(f,token));
 await f.chat('reset',{actionId:'article'});
 let session=f.articleData.current;assert.deepEqual(session.articles,[]);assert.deepEqual(session.requests,{});assert.equal(session.conversation.turns.length,0);
 assert.equal((await f.chat('get')).turns[0].user,'通常は残す');await assert.rejects(start(f,token),/無効/);
 await complete(f,await start(f,await importArticle(f)));delete f.sessionData[f.context.OshaberiNoteArticles.requestSessionKey];
 assert.equal((await f.chat('restore')).actionId,'article');assert.equal((await f.chat('get',{actionId:'article'})).turns.length,1);assert.equal(f.articleData.current.articles.length,1);
 assert.equal((await f.chat('get')).turns[0].user,'通常は残す');
});

test('取得失敗・不一致・上限超過・note以外の送信元では取り込まず、保存失敗は依頼を消費しない',async()=>{
 const f=await ready();
 for(const value of [article('n123','題',''),article('n123','題','a'.repeat(200000))])await assert.rejects(importArticle(f,value));
 f.context.chrome.tabs.get=async()=>({url:'https://note.com/test/n/n456'});
 await assert.rejects(f.send({type:'import-article',patch:{article:article(),pageUrl:article().url}},{id:'test',url:article().url,frameId:0,tab:{id:7}}));
 assert.equal(f.opened.length,0);
 assert.equal(await f.send({type:'import-article',patch:{article:article(),pageUrl:article().url}},{id:'test',url:'https://evil.test/',frameId:0,tab:{id:7}}),undefined);
 const token=await importArticle(f),before=structuredClone(f.articleData);f.fail=true;await assert.rejects(start(f,token),/storage failed/);f.fail=false;assert.deepEqual(f.articleData,before);
 await complete(f,await start(f,token));
});

test('note内の画面遷移で送信元URLが古くても、現在の記事を取り込める',async()=>{
 for(const senderUrl of ['https://note.com/test','https://note.com/test/n/n456']){
  const f=await ready(),value=article();f.context.chrome.tabs.get=async()=>({url:value.url});
  await f.send({type:'import-article',patch:{article:value,pageUrl:value.url}},{id:'test',url:senderUrl,frameId:0,tab:{id:7}});
  assert.equal(f.opened.length,1);assert.equal(f.articleData.current.articles[0].articleId,'n123');
 }
});

test('同じ記事のクエリ・ハッシュ・末尾スラッシュは取り込みを妨げない',async()=>{
 const f=await ready(),value=article();f.context.chrome.tabs.get=async()=>({url:value.url+'/?from=profile',pendingUrl:value.url+'#heading'});
 await f.send({type:'import-article',patch:{article:value,pageUrl:value.url+'?from=other#body'}},{id:'test',url:'https://note.com/test',frameId:0,tab:{id:7}});
 assert.equal(f.opened.length,1);assert.equal(f.articleData.current.articles[0].url,value.url);
});

test('別記事・記事以外・外部URLへの遷移中や古い取得結果は取り込まない',async()=>{
 const value=article(),sender={id:'test',url:'https://note.com/test',frameId:0,tab:{id:7}};
 for(const tab of [
  {url:value.url,pendingUrl:'https://note.com/test/n/n456'},
  {url:value.url,pendingUrl:'https://note.com/test'},
  {url:value.url,pendingUrl:'https://evil.test/test/n/n123'},
  {url:'https://note.com/test/n/n456'},
  {url:'https://note.com/other/n/n123'},
  {url:'https://evil.test/test/n/n123'}
 ]){
  const f=await ready();f.context.chrome.tabs.get=async()=>tab;
  await assert.rejects(f.send({type:'import-article',patch:{article:value,pageUrl:value.url}},sender),/記事ページが変更/);
  assert.equal(f.opened.length,0);assert.equal(f.articleData.current,undefined);
 }
 const f=await ready();f.context.chrome.tabs.get=async()=>({url:value.url});
 await assert.rejects(f.send({type:'import-article',patch:{article:article('n456'),pageUrl:value.url}},sender),/一致しません/);
 assert.equal(f.opened.length,0);
});

test('同じ記事IDの再取り込みはMapを更新し、別記事を削除しない',async()=>{
 const f=await ready();const old=await importArticle(f,article('n123','同名','以前の本文'));await f.send({type:'article-operation',patch:{operation:'cancel',requestToken:old}});await importArticle(f,article('n456','同名','別の記事'));
 await importArticle(f,article('n123','変更した題','最新の本文'));
 const values=f.articleData.current.articles;assert.equal(values.length,2);assert.equal(values.find(a=>a.articleId==='n123').body,'最新の本文');assert.equal(values.find(a=>a.articleId==='n456').body,'別の記事');
});

test('要約の待ち行列はFIFOで共有し、同じ先頭を複数画面から開始しても一度だけ確定する',async()=>{
 const f=await ready();f.connect('other');const a=article('n111','A','本文A'),b=article('n222','B','本文B'),c=article('n333','C','本文C');
 const tokens=[];for(const value of [a,b,c])tokens.push(await importArticle(f,value));
 const snapshot=await f.send({type:'article-operation',patch:{operation:'snapshot'}});assert.deepEqual(snapshot.queue.map(item=>item.articleId),['n111','n222','n333']);assert.ok(!JSON.stringify(snapshot.queue).includes('本文A'));
 await assert.rejects(start(f,tokens[2]),{code:'ARTICLE_QUEUE_WAIT'});assert.equal(Object.keys(f.articleData.current.requests).length,3);
 const results=await Promise.allSettled([start(f,tokens[0]),start(f,tokens[0],'other')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const first=results.find(r=>r.status==='fulfilled').value;
 assert.equal(Object.keys(f.articleData.current.requests).length,2);await f.chat('complete',{actionId:'article',epoch:first.epoch,endpoint:first.endpoint,owner:first.active.owner,model:'local-model',id:first.active.id,text:'A完了'});
 const second=await start(f,tokens[1]);await f.chat('stop',{actionId:'article',owner:second.active.owner,id:second.active.id});assert.deepEqual(Object.keys(f.articleData.current.requests),[tokens[2]]);
 await complete(f,await start(f,tokens[2]),'C完了');assert.equal(Object.keys(f.articleData.current.requests).length,0);assert.deepEqual(f.articleData.current.conversation.turns.map(turn=>turn.status),['complete','interrupted','complete']);
});

test('明示的な中止は実行中と全待機要約を同時に取り消し、保存失敗では取り消し前を維持する',async()=>{
 const f=await ready(),tokens=[];for(const id of ['n111','n222','n333'])tokens.push(await importArticle(f,article(id)));
 await start(f,tokens[0]);const before=structuredClone(f.articleData.current);f.fail=true;
 await assert.rejects(f.chat('stop',{actionId:'article',cancelArticleQueue:true}),/storage failed/);assert.deepEqual(f.articleData.current,before);f.fail=false;
 await f.chat('stop',{actionId:'article',cancelArticleQueue:true});assert.equal(f.articleData.current.conversation.active,null);assert.deepEqual(f.articleData.current.requests,{});assert.equal(f.articleData.current.articles.length,3);
 await assert.rejects(start(f,tokens[1]),/処理済み/);
});

test('同じ記事の並行受付・待機中・実行中の追加は無視し、本文を変更せず完了後は再要約できる',async()=>{
 const f=await ready(),value=article(),sender={id:'test',url:value.url,frameId:0,tab:{id:7}};
 f.context.chrome.tabs.get=async()=>({url:value.url,windowId:3,index:4});
 const submit=article=>f.send({type:'import-article',patch:{article,pageUrl:value.url}},sender);
 const results=await Promise.all([submit(value),submit(value)]);assert.equal(results.filter(r=>r.duplicate).length,1);assert.equal(f.opened.length,1);
 const token=Object.keys(f.articleData.current.requests)[0],before=structuredClone(f.articleData.current);
 assert.equal((await submit({...value,body:'変更後の本文'})).duplicate,true);assert.deepEqual(f.articleData.current,before);
 const running=await start(f,token);assert.equal((await submit(value)).duplicate,true);assert.equal(f.opened.length,1);assert.equal(Object.keys(f.articleData.current.requests).length,0);
 await complete(f,running);assert.equal((await submit(value)).queued,true);assert.equal(f.opened.length,2);
});

test('右隣の自分のホームだけを再利用し、再読込・タブ切替を行わず依頼だけ追加する',async()=>{
 const f=await ready(),value=article(),queries=[];f.context.chrome.tabs.get=async()=>({url:value.url,windowId:9,index:2});
 const notices=[];f.context.chrome.runtime.sendMessage=async message=>{notices.push(structuredClone(message));return {received:true};};
 f.context.chrome.tabs.query=async query=>{queries.push(structuredClone(query));return [{id:8,url:'chrome-extension://test/home.html#article-request=old'}];};
 const result=await f.send({type:'import-article',patch:{article:value,pageUrl:value.url}},{id:'test',url:value.url,frameId:0,tab:{id:7}});
 assert.equal(result.opened,false);assert.equal(result.queued,true);assert.deepEqual(queries,[{windowId:9,index:3}]);assert.equal(f.opened.length,0);assert.equal(Object.keys(f.articleData.current.requests).length,1);
 assert.equal(notices[0].targetTabId,8);assert.equal(notices[0].type,'show-imported-article');assert.equal(notices[0].requestToken,Object.keys(f.articleData.current.requests)[0]);
});

test('右隣が別ページ・遷移中・存在しない場合は同じウィンドウの右隣へ非アクティブで作る',async()=>{
 for(const neighbor of [undefined,{url:'https://note.com/'},{url:'chrome-extension://another/home.html'},{url:'chrome-extension://test/home.html.fake'},{url:'chrome-extension://test/home.html',pendingUrl:'https://example.com/'}]){
  const f=await ready();f.context.chrome.tabs.query=async()=>neighbor?[neighbor]:[];
  await importArticle(f);assert.equal(f.opened.length,1);assert.equal(f.opened[0].windowId,3);assert.equal(f.opened[0].index,5);assert.equal(f.opened[0].active,false);
 }
});

test('右隣の照会失敗では受付せず、タブ作成失敗では待機依頼を残さない',async()=>{
 const f=await ready();f.context.chrome.tabs.query=async()=>{throw Error('query failed');};await assert.rejects(importArticle(f),/query failed/);assert.equal(f.articleData.current,undefined);
 f.context.chrome.tabs.query=async()=>[];f.context.chrome.tabs.create=async()=>{throw Error('create failed');};await assert.rejects(importArticle(f),/create failed/);assert.deepEqual(f.articleData.current.requests,{});
});

test('接続先・モデル変更と拡張OFFで待機を取り消し、ブラウザ再起動でも自動再送しない',async()=>{
 for(const change of [{ollamaModel:'another-model'},{enabled:false},{ollamaUrl:'http://localhost:11434'}]){
  const f=await ready();await importArticle(f);await f.save(change);assert.deepEqual(f.articleData.current.requests,{});
 }
 const f=await ready();await importArticle(f);delete f.sessionData[f.context.OshaberiNoteArticles.requestSessionKey];await f.chat('get',{actionId:'article'});assert.deepEqual(f.articleData.current.requests,{});assert.equal(f.articleData.current.articles.length,1);
});

test('表示中の本文領域だけを抽出し、不可視・スクリプト・有料境界・コメントを除外する',async()=>{
 const f=backend(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time></time></div><div id="note-body" data-name="body"><p id="body"></p><p hidden id="hidden"></p><script id="script"></script></div></div><aside id="paywall"></aside></article><p id="comment"></p>');
 for(const [id,text]of [['title','見える題'],['author','著者名'],['body','表示本文'],['hidden','非表示の秘密'],['script','実行しない'],['paywall','ここから先は購入'],['comment','コメント']])doc.getElementById(id).textContent=text;
 const win={getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'})},api=f.context.OshaberiNoteArticles;
 const region=doc.querySelector('[data-note-key]');
 assert.throws(()=>api.extract(doc,win,article('n456').url),/本文と記事URL/);
 region.removeAttribute('data-note-key');assert.throws(()=>api.extract(doc,win,article().url),/本文と記事URL/);region.setAttribute('data-note-key','n123');
 const extracted=api.extract(doc,win,article().url);assert.equal(extracted.body,'表示本文');assert.equal(extracted.title,'見える題');assert.equal(extracted.author,'著者名');
 doc.getElementById('body').textContent='';assert.throws(()=>api.extract(doc,win,article().url),/空/);
 doc.getElementById('note-body').hidden=true;assert.throws(()=>api.extract(doc,win,article().url),/本文/);
 doc.getElementById('note-body').hidden=false;doc.getElementById('body').textContent='本文';const hidden=doc.createElement('div');hidden.hidden=true;doc.getElementById('note-article').append(hidden);hidden.append(doc.getElementById('title'));assert.throws(()=>api.extract(doc,win,article().url),/タイトル/);
});

test('リンクカードを本文順にタイトル・著者・URLで保存し、送信本文にも含める',async()=>{
 const f=await ready(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time></time></div><div id="note-body" data-name="body"><p id="before"></p><figure embedded-service="external-article" data-src="https://example.com/works"><a href="https://example.com/works"><strong class="external-article-widget-title" id="card-title"></strong><em id="description"></em></a><a href="https://example.com/works"></a></figure><figure embedded-service="note" data-src="https://note.com/other/n/n456"><iframe id="frame" src="https://note.com/embed/notes/n456"></iframe></figure><figure embedded-service="note" data-src="https://note.com/other/n/n789"><iframe></iframe></figure><p id="after"></p></div></div></article>');
 for(const [id,text]of [['title','リンク集'],['author','著者'],['before','前の本文'],['after','後の本文'],['card-title','外部作品の題名'],['description','カードの説明文は送らない']])doc.getElementById(id).textContent=text;
 const child=documentFromHtml('<a class="p-noteEmbed__link" href="https://note.com/other/n/n456"></a><div class="p-noteEmbed__title" id="linked-title"></div><div class="p-noteEmbed__name"><a id="card-author" href="https://note.com/other"></a></div><p id="unrelated"></p>');
 child.URL='https://note.com/embed/notes/n456';child.getElementById('linked-title').textContent='note作品の題名';child.getElementById('unrelated').textContent='スキ数は送らない';child.getElementById('card-author').textContent='参照先の作者';doc.getElementById('frame').contentDocument=child;
 const win={getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'})};
 const value=f.context.OshaberiNoteArticles.extract(doc,win,article().url);
 assert.ok(value.body.indexOf('前の本文')<value.body.indexOf('外部作品の題名'));
 assert.ok(value.body.indexOf('外部作品の題名')<value.body.indexOf('note作品の題名'));
 assert.ok(value.body.indexOf('note作品の題名')<value.body.indexOf('後の本文'));
 for(const url of ['https://example.com/works','https://note.com/other/n/n456','https://note.com/other/n/n789'])assert.equal(value.body.split(url).length-1,1);
 assert.match(value.body,/タイトル：（タイトル未取得）/);
 assert.ok(value.body.includes('タイトル：外部作品の題名\nURL：https://example.com/works'));
 assert.ok(value.body.includes('タイトル：note作品の題名\n著者：参照先の作者\nURL：https://note.com/other/n/n456'));assert.equal(value.body.split('著者：（著者未取得）').length-1,1);
 const cardAuthor=child.getElementById('card-author');cardAuthor.setAttribute('href','https://note.com/wrong');assert.ok(!f.context.OshaberiNoteArticles.extract(doc,win,article().url).body.includes('参照先の作者'));cardAuthor.setAttribute('href','https://note.com/other');cardAuthor.hidden=true;assert.ok(!f.context.OshaberiNoteArticles.extract(doc,win,article().url).body.includes('参照先の作者'));
 assert.ok(!value.body.includes('説明文は送らない'));assert.ok(!value.body.includes('スキ数は送らない'));
 const state=await start(f,await importArticle(f,value));assert.ok(state.messages.at(-1).content.includes(value.body));
});

test('クリエーターページのカードは記事と区別し、表示中の紹介文とURLを保存・送信する',async()=>{
 const f=await ready(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time></time></div><div id="note-body" data-name="body"><figure embedded-service="external-article" data-src="https://note.com/legal_knot1730" id="card"><div><a id="card-link" href="https://note.com/legal_knot1730"><strong class="external-article-widget-title" id="card-title"></strong><em class="external-article-widget-description" id="description"></em></a></div></figure><p id="after"></p></div></div></article>');
 for(const [id,text]of [['title','紹介記事'],['author','記事の著者'],['card-title','言ノ葉しをり Shioiri Kotonoha｜note'],['description','将来小説家になる、まだ誰も知らない中学生。'],['after','このユーザを見てほしい']])doc.getElementById(id).textContent=text;
 const win={getComputedStyle:n=>({display:n.hidden?'none':'block',visibility:'visible'})},extract=()=>f.context.OshaberiNoteArticles.extract(doc,win,article().url);
 const value=extract();assert.match(value.body,/\[リンクカード\]\n種類：クリエーターページ\nタイトル：言ノ葉しをり Shioiri Kotonoha｜note\n紹介文：将来小説家になる、まだ誰も知らない中学生。\nURL：https:\/\/note.com\/legal_knot1730/);
 assert.ok(!value.body.includes('著者：'));assert.ok(value.body.indexOf('クリエーターページ')<value.body.indexOf('このユーザ'));
 const state=await start(f,await importArticle(f,value));assert.ok(state.messages.at(-1).content.includes(value.body));
 const description=doc.getElementById('description');description.hidden=true;assert.ok(!extract().body.includes('紹介文：'));description.hidden=false;
 const link=doc.getElementById('card-link');link.setAttribute('href','https://note.com/other');const mismatched=extract().body;assert.ok(!mismatched.includes('言ノ葉しをり'));assert.ok(!mismatched.includes('将来小説家'));
 for(const url of ['https://note.com/search','https://note.com/preview','https://example.com/legal_knot1730','https://note.com.evil.test/legal_knot1730','https://note.com/legal_knot1730/n/n456']){
  doc.getElementById('card').setAttribute('data-src',url);link.setAttribute('href',url);const body=extract().body;assert.ok(!body.includes('種類：クリエーターページ'));assert.ok(!body.includes('紹介文：'));assert.equal(body.includes('著者：（著者未取得）'),new URL(url).origin==='https://note.com');
 }
});

test('GitHub埋め込みは外側の元URLを一度だけ保存・送信し、iframe内部を読まない',async()=>{
 const f=await ready(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time></time></div><div id="note-body" data-name="body"><p id="before"></p><figure embedded-service="githubRepository" data-src="https://github.com/ruminar/OpenGepa" id="card"><div><a href="https://github.com/ruminar/OpenGepa" data-iframely-url="//iframely.net/HYDXw0b3"></a><iframe id="frame" src="https://iframely.net/HYDXw0b3?v=1"></iframe></div><figcaption id="caption"></figcaption></figure><p id="after"></p></div></div></article>');
 for(const [id,text]of [['title','埋め込みの記事'],['author','著者'],['before','前の本文'],['caption','キャプション'],['after','後の本文']])doc.getElementById(id).textContent=text;
 Object.defineProperty(doc.getElementById('frame'),'contentDocument',{get(){assert.fail('iframe内部へアクセスしてはいけない');}});
 const win={getComputedStyle:n=>({display:n.hidden?'none':'block',visibility:'visible'})},extract=()=>f.context.OshaberiNoteArticles.extract(doc,win,article().url);
 const value=extract();assert.ok(value.body.includes('[リンクカード]\nURL：https://github.com/ruminar/OpenGepa'));assert.equal(value.body.split('https://github.com/ruminar/OpenGepa').length-1,1);assert.ok(!value.body.includes('iframely.net'));assert.ok(!value.body.includes('未取得'));
 assert.ok(value.body.indexOf('前の本文')<value.body.indexOf('https://github.com'));assert.ok(value.body.indexOf('https://github.com')<value.body.indexOf('キャプション'));assert.ok(value.body.indexOf('キャプション')<value.body.indexOf('後の本文'));
 const state=await start(f,await importArticle(f,value));assert.ok(state.messages.at(-1).content.includes(value.body));
 const card=doc.getElementById('card');card.hidden=true;assert.ok(!extract().body.includes('https://github.com'));card.hidden=false;
 for(const url of ['javascript:alert(1)','https://user:password@github.com/ruminar/OpenGepa']){card.setAttribute('data-src',url);const body=extract().body;assert.ok(!body.includes('javascript:'));assert.ok(!body.includes('user:password'));assert.ok(body.includes('https://github.com/ruminar/OpenGepa'));}
});

function embedFixture(html) {
 const f=backend(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time></time></div><div id="note-body" data-name="body"><p id="before"></p>'+html+'<p id="after"></p></div></div></article>');
 for(const [id,text]of [['title','埋め込みの題'],['author','著者'],['before','前の本文'],['after','後の本文']])doc.getElementById(id).textContent=text;
 const win={getComputedStyle:n=>({display:n.hidden?'none':'block',visibility:n.getAttribute('style')?.includes('visibility:hidden')?'hidden':'visible'}),scrollTo:()=>assert.fail('スクロールしない')};
 for(const frame of doc.querySelectorAll('iframe'))Object.defineProperty(frame,'contentDocument',{get(){assert.fail('URL補完はiframe内部を読まない');}});
 return {doc,extract:()=>f.context.OshaberiNoteArticles.extract(doc,win,article().url)};
}

test('未知の埋め込みも外側の元URLを優先し、iframe属性の変更・内部取得をしない',async()=>{
 const f=embedFixture('<figure embedded-service="oembed" data-src="https://example.com/item/123"><iframe id="frame" src="https://embed.example.com/player" data-src="https://embed.example.com/lazy"></iframe></figure>');
 const frame=f.doc.getElementById('frame');frame.setAttribute=()=>assert.fail('iframe属性を書き換えない');
 const value=f.extract();assert.ok(value.body.includes('[リンクカード]\nURL：https://example.com/item/123'));assert.ok(!value.body.includes('embed.example.com'));
 const backendState=await ready(),state=await start(backendState,await importArticle(backendState,value));assert.ok(state.messages.at(-1).content.includes(value.body));
});

test('古いnoteカードは未読込iframeの属性から埋め込みURLを残し、作者を推測しない',()=>{
 const f=embedFixture('<figure embedded-service="note" data-identifier="nOld"><iframe src="about:blank" data-src="https://note.com/embed/notes/nOld" style="visibility:hidden"></iframe></figure>');
 const body=f.extract().body;assert.ok(body.includes('[リンクカード]\n埋め込みURL：https://note.com/embed/notes/nOld'));assert.ok(!body.includes('著者：'));assert.ok(!body.includes('/test/n/nOld'));
 const linked=embedFixture('<figure embedded-service="note"><a href="https://note.com/other/n/nOld"></a><iframe src="https://note.com/embed/notes/nOld"></iframe></figure>');assert.ok(linked.extract().body.includes('URL：https://note.com/other/n/nOld'));
});

test('確認済みYouTube・Spotify・CodePenの表示用URLだけを通常URLへ変換する',()=>{
 const cases=[
  ['https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?start=12&list=PL123','https://www.youtube.com/watch?v=M7lc1UVf-VE&list=PL123&t=12s'],
  ['https://open.spotify.com/embed/playlist/37i9dQZF1DXayDMsJG9ZBv?theme=0','https://open.spotify.com/playlist/37i9dQZF1DXayDMsJG9ZBv'],
  ['https://codepen.io/mp3/embed/preview/bBByaE?height=300','https://codepen.io/mp3/pen/bBByaE'],
  ['https://codepen.io/user/embed/Abc#part','https://codepen.io/user/pen/Abc#part']
 ];
 for(const [src,url]of cases){const f=embedFixture('<figure embedded-service="player"><iframe id="frame"></iframe></figure>');f.doc.getElementById('frame').setAttribute('src',src);const body=f.extract().body;assert.ok(body.includes(`\nURL：${url}\n`),body);assert.ok(!body.includes('埋め込みURL：'));}
});

test('変換できない表示用URLは区別して保持し、見た目が似たドメインは変換しない',()=>{
 for(const src of ['https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123','https://bandcamp.com/EmbeddedPlayer/track=123/','https://note.com/embed/sounds/abc','https://iframely.net/opaque','https://open.spotify.com.evil.test/embed/playlist/37i9dQZF1DXayDMsJG9ZBv','https://www.youtube.com/embed/videoseries?list=PL123','https://www.youtube.com/embed/live_stream?channel=UC123']){
  const f=embedFixture('<figure embedded-service="player"><iframe id="frame"></iframe></figure>');f.doc.getElementById('frame').setAttribute('src',src);const body=f.extract().body;assert.ok(body.includes(`埋め込みURL：${src}`),`${src}: ${body}`);
 }
 const f=embedFixture('<figure embedded-service="note-sound" data-src="https://note.com/embed/sounds/abc"><iframe src="https://note.com/embed/sounds/abc"></iframe></figure>');assert.equal(f.extract().body.split('https://note.com/embed/sounds/abc').length-1,1);assert.ok(f.extract().body.includes('埋め込みURL：'));
});

test('空アンカーの元URLを補完し、サービスのトップリンクやキャプションを元URLと混同しない',()=>{
 const gist=embedFixture('<figure embedded-service="gist"><a href="https://gist.github.com/user/abc#file" data-iframely-url="//iframely.net/widget"></a><iframe src="https://iframely.net/widget"></iframe></figure>');
 assert.ok(gist.extract().body.includes('URL：https://gist.github.com/user/abc#file'));assert.ok(!gist.extract().body.includes('iframely.net'));
 const f=embedFixture('<figure embedded-service="oembed"><a href="https://example.com/" id="domain"></a><iframe src="https://example.com/item/123/embed"></iframe><figcaption><a href="https://credits.example.com/source" id="caption"></a></figcaption></figure>');
 f.doc.getElementById('domain').textContent='example.com';f.doc.getElementById('caption').textContent='出典の説明';const body=f.extract().body;assert.ok(body.includes('埋め込みURL：https://example.com/item/123/embed'));assert.equal(body.split('出典の説明').length-1,1);
});

test('外側URLのない旧外部カードもタイトルリンクから従来形式へ復元する',()=>{
 const f=embedFixture('<figure embedded-service="external-article"><a href="https://example.com/"><strong class="external-article-widget-title" id="card-title"></strong></a></figure>');f.doc.getElementById('card-title').textContent='元サイトの題';assert.ok(f.extract().body.includes('タイトル：元サイトの題\nURL：https://example.com/'));
});

test('埋め込みの危険URL・不可視・srcdoc本文は取得せず、複数URLとURL不明の存在を残す',()=>{
 const f=embedFixture('<figure embedded-service="unknown"><iframe src="javascript:alert(1)" data-src="https://user:password@example.com/"></iframe><iframe hidden src="https://hidden.example.com/"></iframe><iframe srcdoc="秘密の本文"></iframe></figure>');
 const body=f.extract().body;assert.ok(body.includes('[リンクカード]\nURL：（未取得）'));for(const text of ['javascript:','password','hidden.example','秘密の本文'])assert.ok(!body.includes(text));
 const multiple=embedFixture('<figure embedded-service="unknown"><iframe src="https://example.com/a"></iframe><iframe src="https://example.com/b"></iframe><iframe src="https://example.com/a"></iframe></figure>').extract().body;
 assert.equal(multiple.split('https://example.com/a').length-1,1);assert.equal(multiple.split('https://example.com/b').length-1,1);
});

test('URL補完をしても既存の投稿文・キャプションを消さず、通常の空アンカーは拾わない',()=>{
 const f=embedFixture('<figure embedded-service="twitter" data-src="https://x.com/user/status/123"><blockquote><p id="post"></p></blockquote><figcaption id="caption"></figcaption></figure><a href="https://tracking.example.com/empty"></a>');f.doc.getElementById('post').textContent='表示中の投稿文';f.doc.getElementById('caption').textContent='キャプション';const body=f.extract().body;assert.ok(body.includes('URL：https://x.com/user/status/123'));assert.ok(body.includes('表示中の投稿文'));assert.equal(body.split('キャプション').length-1,1);assert.ok(!body.includes('tracking.example.com'));
});

test('カードの不可視情報・別URLのフレーム・危険なURLを取り込まない',()=>{
 const f=backend(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time></time></div><div id="note-body" data-name="body"><p id="text"></p><figure hidden embedded-service="external-article" data-src="https://secret.test/"><a href="https://secret.test/"><strong class="external-article-widget-title" id="hidden-title"></strong></a></figure><figure embedded-service="external-article" data-src="javascript:alert(1)"></figure><figure embedded-service="external-article" data-src="https://user:password@example.com/"></figure><figure embedded-service="note" data-src="https://note.com/other/n/n456"><iframe id="frame" src="https://note.com/embed/notes/n456"></iframe></figure></div></div></article>');
 for(const [id,text]of [['title','安全な記事'],['author','著者'],['text','本文'],['hidden-title','秘密のタイトル']])doc.getElementById(id).textContent=text;
 const frame=doc.getElementById('frame'),child=documentFromHtml('<a class="p-noteEmbed__link" href="https://note.com/other/n/n456"></a><div class="p-noteEmbed__title" id="wrong"></div>');child.getElementById('wrong').textContent='別の記事のタイトル';child.URL='https://note.com/embed/notes/n999';frame.contentDocument=child;
 const win={getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'})},api=f.context.OshaberiNoteArticles;
 let body=api.extract(doc,win,article().url).body;
 for(const text of ['secret.test','秘密','javascript:','password','別の記事'])assert.ok(!body.includes(text));
 assert.ok(body.includes('https://note.com/other/n/n456'));
 Object.defineProperty(frame,'contentDocument',{get(){throw Error('SecurityError');}});
 body=api.extract(doc,win,article().url).body;assert.ok(body.includes('https://note.com/other/n/n456'));
});

test('記事DB保存後に共通設定の保存が失敗したら、既存の記事Mapと選択を巻き戻す',async()=>{
 const f=await ready();await complete(f,await start(f,await importArticle(f)));await f.chat('select',{actionId:'chat',owner:'owner'});
 const beforeLocal=structuredClone(f.data),beforeSession=structuredClone(f.articleData),opened=f.opened.length;
 const store=f.context.chrome.storage.local.set;f.context.chrome.storage.local.set=async()=>{throw Error('local failed');};
 await assert.rejects(importArticle(f,article('n456','別の記事','別の本文')),/local failed/);f.context.chrome.storage.local.set=store;
 assert.deepEqual(f.data,beforeLocal);assert.deepEqual(f.articleData,beforeSession);assert.equal(f.opened.length,opened);
});

test('Firefoxの記事送信はwebsiteContent同意も確認し、拒否中でも通常会話は使える',async()=>{
 const f=backend({firefox:true});f.connect('owner');await f.save({ollamaModel:'local-model'});
 let website=false;const contains=f.context.chrome.permissions.contains;f.context.chrome.permissions.contains=async options=>{const allowed=await contains(options);return allowed&&(!options.data_collection?.includes('websiteContent')||website);};
 const normal=await f.chat('get'),patch={epoch:normal.epoch,endpoint:normal.endpoint,owner:'owner',model:'local-model'};await f.chat('approve',patch);
 const token=await importArticle(f);await assert.rejects(start(f,token),/未許可/);
 const n=await f.chat('start',{...patch,text:'通常の質問'});await f.chat('complete',{...patch,id:n.active.id,text:'回答'});
 website=true;await complete(f,await start(f,token));
 assert.ok(f.permissionChecks.some(options=>options.data_collection?.includes('websiteContent')));
});

test('旧版の送信本文複製を読込時に削除し、表示履歴と記事Mapは維持する',async()=>{
 const f=await ready(),a=article('n123','以前の記事','Mapに残す本当の本文');await complete(f,await start(f,await importArticle(f,a)),'表示に残す過去の回答');
 const key=f.context.OshaberiNoteArticles.key,session=f.articleData.current;
 session.conversation.turns[0].llmText='旧形式の依頼文と偽の古い本文';delete session.activeArticleId;
 const state=await f.chat('get',{actionId:'article'});
 assert.equal(state.turns[0].assistant,'表示に残す過去の回答');assert.equal(state.turns[0].user,'[&以前の記事]について要約して');
 assert.equal(state.turns[0].llmText,undefined);assert.equal(f.articleData.current.conversation.turns[0].llmText,undefined);
 assert.equal(f.articleData.current.articles[0].body,a.body);assert.equal(f.articleData.current.activeArticleId,a.articleId);
 const next=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text:'感想',articleId:a.articleId,articleAction:'impression'});
 assert.equal(next.messages.length,2);assert.ok(next.messages[1].content.includes(a.body));assert.ok(next.messages.every(m=>!m.content.includes('偽の古い本文')&&!m.content.includes('表示に残す過去の回答')));
});

async function ask(f,segment,text='なぜですか？') {
 const state=await f.chat('get',{actionId:'article'});
 return f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text,articleSegmentId:segment});
}

test('自由入力は共有の最新区間だけを使い、古い対象からの送信を保存前に拒否する',async()=>{
 const f=await ready(),a=article('n123','同名','Aだけの本文'),b=article('n456','同名','Bだけの本文');
 const first=await start(f,await importArticle(f,a)),aId=first.turns.at(-1).articleSegmentId;await complete(f,first,'Aだけの要約');
 const second=await start(f,await importArticle(f,b)),bId=second.turns.at(-1).articleSegmentId;await complete(f,second,'Bだけの要約');
 assert.equal((await f.chat('get',{actionId:'article'})).activeArticleSegmentId,bId);
 const before=structuredClone(f.articleData);await assert.rejects(ask(f,aId),e=>e.code==='STALE_ARTICLE_CONTEXT');assert.deepEqual(f.articleData,before);
 const followB=await ask(f,bId,'その説明を詳しく');assert.ok(JSON.stringify(followB.messages).includes('Bだけの要約'));assert.ok(!JSON.stringify(followB.messages).includes('Aだけ'));await complete(f,followB);
 let state=await f.chat('get',{actionId:'article'});
 const fresh=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text:'感想',articleId:a.articleId,articleAction:'impression'});
 assert.notEqual(fresh.activeArticleSegmentId,aId);assert.equal(fresh.activeArticleSegmentId,fresh.turns.at(-1).articleSegmentId);assert.equal(fresh.messages.length,2);assert.ok(!JSON.stringify(fresh.messages).includes('Aだけの要約'));await complete(f,fresh);
 await assert.rejects(ask(f,undefined),/未選択/);await assert.rejects(ask(f,'unknown'),/未選択/);
 await f.chat('reset',{actionId:'article'});await assert.rejects(ask(f,aId),/未選択/);
});

test('10往復を超えても起点と記事本文を維持し、中断回答と偽の参照を混ぜない',async()=>{
 const f=await ready(),a=article(),first=await start(f,await importArticle(f,a)),id=first.turns.at(-1).articleSegmentId;
 await complete(f,first,'最初の要約');
 for(let i=0;i<12;i++)await complete(f,await ask(f,id,'追加質問'+i),'追加回答'+i);
 let state=await f.chat('get',{actionId:'article'});assert.equal(state.turns.length,13);assert.equal(state.turns[0].articleAction,'summary');assert.equal(state.droppedTurns,0);assert.equal(state.articleSegments[id].articleId,a.articleId);
 const stopped=await ask(f,id,'中断する質問');await f.chat('progress',{actionId:'article',epoch:stopped.epoch,endpoint:stopped.endpoint,model:'local-model',owner:'owner',id:stopped.active.id,text:'中断回答の秘密'});await f.chat('stop',{actionId:'article'});
 const follow=await ask(f,id,'[&別記事] なぜ？');const serialized=JSON.stringify(follow.messages);
 assert.equal(serialized.split(a.body).length-1,1);assert.match(follow.messages[1].content,/極力意味を失わない/);assert.ok(!serialized.includes('中断回答の秘密'));assert.ok(serialized.includes('最初の要約'));
 assert.equal(follow.turns.at(-1).articleId,a.articleId);
 const session=f.articleData.current;assert.ok(!JSON.stringify(session.conversation).includes(a.body));assert.ok(session.conversation.turns.every(t=>!t.llmText&&!t.llmMessages&&!t.articleSegment));
});

test('区間履歴と本文が上限を超えたときは、他区間へ切り替えず履歴を変更しない',async()=>{
 const f=await ready(),first=await start(f,await importArticle(f)),id=first.turns.at(-1).articleSegmentId;
 await complete(f,first,'回答'.repeat(16000));
 for(let i=0;i<7;i++)await complete(f,await ask(f,id,'質問'+i),'回答'.repeat(16000));
 const before=structuredClone(f.articleData);
 await assert.rejects(ask(f,id,'上限の確認'),/会話区間が送信上限/);
 assert.deepEqual(f.articleData,before);
});


test('再起動で未処理依頼を無効化し、生成途中の回答は中断表示で復元する',async()=>{
 const f=await ready(),token=await importArticle(f),pending=await start(f,token),articleId=pending.turns[0].articleId,segment=pending.activeArticleSegmentId;
 await f.chat('progress',{actionId:'article',epoch:pending.epoch,endpoint:pending.endpoint,model:'local-model',owner:'owner',id:pending.active.id,text:'途中までの回答'});
 const unused=await importArticle(f,article('n456','B','再起動前の別記事'));
 const restarted=backend();Object.assign(restarted.data,structuredClone(f.data));restarted.articleData.current=structuredClone(f.articleData.current);restarted.connect('owner');
 const state=await restarted.chat('get',{actionId:'article'});
 assert.equal(state.turns[0].articleId,articleId);assert.equal(state.turns[0].assistant,'途中までの回答');assert.equal(state.turns[0].status,'interrupted');assert.equal(state.active,null);assert.equal(state.activeArticleSegmentId,segment);
 assert.equal(restarted.articleData.current.articles.length,2);assert.deepEqual(restarted.articleData.current.requests,{});await assert.rejects(start(restarted,unused),/無効/);assert.equal(restarted.opened.length,0);
 const snapshot=await restarted.send({type:'article-operation',patch:{operation:'snapshot'}});assert.ok(snapshot.articles.every(a=>!Object.hasOwn(a,'body')));assert.ok(!JSON.stringify(restarted.data).includes('再起動前の別記事'));
});

test('旧セッションから永続DBへ移行し、保存失敗では元データを残して再試行できる',async()=>{
 const f=await ready();await complete(f,await start(f,await importArticle(f)),'旧形式の回答');
 const migrated=backend();Object.assign(migrated.data,structuredClone(f.data));const legacy=structuredClone(f.articleData.current);delete legacy.requestSessionId;
 migrated.sessionData[migrated.context.OshaberiNoteArticles.key]=legacy;migrated.connect('owner');
 const set=migrated.context.chrome.storage.local.set;migrated.context.chrome.storage.local.set=async()=>{throw Error('local failed');};
 await assert.rejects(migrated.chat('get',{actionId:'article'}),/local failed/);assert.equal(migrated.articleData.current,undefined);assert.deepEqual(migrated.sessionData[migrated.context.OshaberiNoteArticles.key],legacy);
 migrated.context.chrome.storage.local.set=set;const state=await migrated.chat('get',{actionId:'article'});assert.equal(state.turns[0].assistant,'旧形式の回答');assert.equal(migrated.articleData.current.articles[0].body,article().body);assert.equal(migrated.sessionData[migrated.context.OshaberiNoteArticles.key],undefined);
});


test('記事は100往復を超えても読込・再起動・追加送信で件数整理しない',async()=>{
 const f=await ready(),first=await start(f,await importArticle(f));await complete(f,first,'最初の回答');
 const record=f.articleData.current,template=record.conversation.turns[0],id=template.articleSegmentId;
 for(let i=0;i<120;i++)record.conversation.turns.push({...template,user:'質問'+i,assistant:'回答'+i,articleAction:'question',articleSourceHash:undefined});
 const state=await f.chat('get',{actionId:'article'});assert.equal(state.turns.length,121);assert.equal(state.droppedTurns,0);
 const restarted=backend();Object.assign(restarted.data,structuredClone(f.data));restarted.articleData.current=structuredClone(f.articleData.current);restarted.connect('owner');
 assert.equal((await restarted.chat('get',{actionId:'article'})).turns.length,121);
 const added=await ask(restarted,id);assert.equal(added.turns.length,122);assert.equal(added.droppedTurns,0);assert.equal(added.messages.length,244);await complete(restarted,added);
});

test('記事の件数制限を外しても履歴2MiBの容量整理と本文保持は維持する',async()=>{
 const f=await ready(),first=await start(f,await importArticle(f));await complete(f,first);
 const record=f.articleData.current,template=record.conversation.turns[0];
 record.conversation.turns=Array.from({length:120},(_,i)=>({...template,user:'表示する依頼'+i,assistant:'文'.repeat(5500)}));
 const state=await f.chat('get',{actionId:'article'});assert.equal(state.turns.length,120);
 const next=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text:'要約',articleId:template.articleId,articleAction:'summary'});
 assert.ok(next.droppedTurns>0);assert.ok(f.context.OshaberiNoteChatState.bytes(f.articleData.current.conversation)<=2097152);assert.equal(f.articleData.current.articles[0].body,article().body);await complete(f,next);
});


test('記事の本人情報は送信時のユーザーIDで判断し、全操作と自由入力へ付与するが記事や表示履歴には保存しない',async()=>{
 const f=await ready(),value=article('n123','自分の作品','本人の本文');value.author='るみなー先生';
 const relation='利用者と著者の関係：利用者本人が書いた記事です。';
 let state=await start(f,await importArticle(f,value));const system=state.messages[0].content;
 assert.ok(!state.messages.at(-1).content.includes(relation));await complete(f,state);
 await f.save({noteUserId:'TeSt'});
 for(const action of ['summary','impression','revision','citations']){
  state=await f.chat('get',{actionId:'article'});
  state=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'owner',model:'local-model',text:'依頼',articleId:value.articleId,articleAction:action});
  assert.equal(state.messages[0].content,system);assert.equal(state.messages[1].content.split(relation).length-1,1);
  assert.ok(state.messages[1].content.includes('著者：るみなー先生\n'+relation));
  assert.ok(!state.turns.at(-1).user.includes(relation));await complete(f,state);
 }
 const follow=async()=>{const current=await f.chat('get',{actionId:'article'});return f.chat('start',{actionId:'article',epoch:current.epoch,endpoint:current.endpoint,owner:'owner',model:'local-model',text:'続きを教えて',articleSegmentId:current.activeArticleSegmentId});};
 await f.save({noteUserId:'someone_else'});state=await follow();assert.ok(state.messages.every(m=>!m.content.includes(relation)));await complete(f,state);
 await f.save({noteUserId:'test'});state=await follow();assert.equal(state.messages.map(m=>m.content).join('\n').split(relation).length-1,1);await complete(f,state);
 await f.save({noteUserId:''});state=await follow();assert.ok(state.messages.every(m=>!m.content.includes(relation)));await complete(f,state);
 assert.equal(f.articleData.current.articles[0].author,'るみなー先生');assert.ok(!JSON.stringify(f.articleData.current).includes(relation));
});


test('添付ファイルはファイル名・サイズ・URLへ整形し、操作文言を除いて保存・送信する',async()=>{
 const f=await ready(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time></time></div><div id="note-body" data-name="body"><p id="before"></p><figure embedded-service="attachment" id="attachment"><div><a class="file-widget__link" href="https://note.com/api/v2/attachments/download/fe2a0438f7f580abf17fd054ff1c036d"><div><strong class="file-widget__filename" id="filename"></strong><div class="file-widget__filesize" id="filesize"></div><span id="disclaimer"></span></div><div id="download"></div></a></div><figcaption id="caption"></figcaption></figure><p id="after"></p></div></div></article>');
 for(const [id,text]of [['title','添付の記事'],['author','著者'],['before','前の本文'],['filename','iconSet_default.zip'],['filesize','783 KB'],['disclaimer','ファイルダウンロードについて'],['download','ダウンロード'],['caption','添付の説明'],['after','後の本文']])doc.getElementById(id).textContent=text;
 const win={getComputedStyle:n=>({display:n.hidden?'none':'block',visibility:'visible'})},extract=()=>f.context.OshaberiNoteArticles.extract(doc,win,article().url);
 const value=extract(),url='https://note.com/api/v2/attachments/download/fe2a0438f7f580abf17fd054ff1c036d';
 assert.ok(value.body.includes(`[ファイルダウンロード]\nファイル名：iconSet_default.zip （783 KB）\nリンク先URL：${url}`));assert.equal(value.body.split(url).length-1,1);assert.ok(!value.body.includes('ファイルダウンロードについて'));
 assert.ok(value.body.indexOf('前の本文')<value.body.indexOf('ファイル名：'));assert.ok(value.body.indexOf(url)<value.body.indexOf('添付の説明'));assert.ok(value.body.indexOf('添付の説明')<value.body.indexOf('後の本文'));
 const state=await start(f,await importArticle(f,value));assert.ok(state.messages.at(-1).content.includes(value.body));
 doc.getElementById('filesize').hidden=true;assert.ok(extract().body.includes(`ファイル名：iconSet_default.zip\nリンク先URL：${url}`));assert.ok(!extract().body.includes('783 KB'));
 doc.getElementById('attachment').hidden=true;assert.ok(!extract().body.includes('iconSet_default.zip'));
});

test('本文中の文字列リンクと添付ファイルのURLを文字の位置に残し、非表示・画像だけ・危険なリンクを除外する',async()=>{
 const f=await ready(),doc=documentFromHtml('<article id="note-article"><div data-note-key="n123"><h1 id="title"></h1><div><a href="https://note.com/test" id="author"></a><time></time></div><div id="note-body" data-name="body"><p id="intro"></p><p><a href="https://note.com/other/n/n456"><strong id="link-text"></strong></a></p><figure embedded-service="attachment"><a href="https://note.com/api/v2/attachments/download/key"><strong id="file"></strong></a></figure><a id="url-text" href="https://example.org/plain"></a><a hidden href="https://hidden.example/"><span id="hidden"></span></a><a href="javascript:alert(1)" id="unsafe"></a><a href="https://user:secret@example.com/" id="credentials"></a><a href="https://image.example/full"><img></a><p id="end"></p></div></div></article>');
 for(const [id,text]of [['title','リンク付き記事'],['author','筆者'],['intro','私の考えです。'],['link-text','鳥ランド'],['file','参照プロンプト.md'],['url-text','https://example.org/plain'],['hidden','秘密'],['unsafe','危険リンクの文字'],['credentials','認証リンクの文字'],['end','記事の終わり']])doc.getElementById(id).textContent=text;
 const win={getComputedStyle:node=>({display:node.hidden?'none':'block',visibility:'visible'})};
 const value=f.context.OshaberiNoteArticles.extract(doc,win,article().url);
 assert.ok(value.body.includes('鳥ランド（リンク先URL：https://note.com/other/n/n456）'));
 assert.ok(value.body.includes('参照プロンプト.md（リンク先URL：https://note.com/api/v2/attachments/download/key）'));
 assert.equal(value.body.split('https://example.org/plain').length-1,1);
 for(const excluded of ['hidden.example','秘密','javascript:','secret@example.com','image.example'])assert.ok(!value.body.includes(excluded));
 assert.ok(value.body.indexOf('鳥ランド')<value.body.indexOf('参照プロンプト.md'));assert.ok(value.body.indexOf('参照プロンプト.md')<value.body.indexOf('記事の終わり'));
 const state=await start(f,await importArticle(f,value));assert.ok(state.messages[1].content.includes(value.body));

 await complete(f,state);
 const current=await f.chat('get',{actionId:'article'});
 const citation=await f.chat('start',{actionId:'article',epoch:current.epoch,endpoint:current.endpoint,owner:'owner',model:'local-model',text:'列挙',articleId:value.articleId,articleAction:'citations'});
 const index='["https://note.com/other/n/n456","https://note.com/api/v2/attachments/download/key","https://example.org/plain"]';
 assert.ok(citation.messages[1].content.includes('全3件'));assert.ok(citation.messages[1].content.includes(index));
 await complete(f,citation);const active=await f.chat('get',{actionId:'article'});
 const follow=await f.chat('start',{actionId:'article',epoch:active.epoch,endpoint:active.endpoint,owner:'owner',model:'local-model',text:'その参照先を詳しく',articleSegmentId:active.activeArticleSegmentId});
 assert.ok(follow.messages[1].content.includes(index));assert.ok(!JSON.stringify(f.articleData.current).includes('参照先URL一覧'));
 const prompt=f.context.OshaberiNoteArticles.actions.citations.instruction;
 for(const rule of ['参照元の一覧','[リンクカード]','添付ファイル','著者自身の別記事','省略しない','それだけを根拠に引用と判定しない','他者や外部資料からの引用','リンク先の本文は取得していません'])assert.ok(prompt.includes(rule));
});


const authored=(authorId,id,title,body)=>({...article(id,title,body),author:'同じ表示名',url:`https://note.com/${authorId}/n/${id}`});
async function summarizeArticle(f,value,text){return complete(f,await start(f,await importArticle(f,value)),text);}
async function startArticleAction(f,value,action){const state=await f.chat('get',{actionId:'article'});return f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'owner',model:'local-model',text:'依頼',articleId:value.articleId,articleAction:action});}

test('著者IDごとの要約Mapを感想とその続きだけに付与し、対象自身・別著者・他記事本文を除外する',async()=>{
 const f=await ready(),a10=authored('alpha','nA10','第10話','BODY-A10'),a2=authored('ALPHA','nA2','第2話','BODY-A2'),b=authored('beta','nB1','第1話','BODY-B1'),target=authored('alpha','nA3','第3話','BODY-TARGET');
 await summarizeArticle(f,a10,'SUM-A10');await summarizeArticle(f,a2,'SUM-A2');await summarizeArticle(f,b,'SUM-BETA');await summarizeArticle(f,target,'SUM-SELF');
 assert.equal(f.articleData.current.summaries.length,4);assert.equal(f.articleData.current.summaries[1].authorId,'alpha');
 let state=await startArticleAction(f,target,'impression'),text=JSON.stringify(state.messages);
 assert.equal(state.messages.length,2);assert.ok(text.includes('BODY-TARGET'));assert.ok(text.includes('SUM-A10'));assert.ok(text.includes('SUM-A2'));
 for(const secret of ['BODY-A10','BODY-A2','BODY-B1','SUM-BETA','SUM-SELF'])assert.ok(!text.includes(secret));
 assert.ok(text.includes('連作を形成しているかもしれません'));assert.ok(text.includes('同じ著者というだけで連作とは限りません'));
 assert.deepEqual(JSON.parse(state.messages[1].content.split('\n').at(-1)).map(r=>r.articleId),['nA2','nA10']);
 await complete(f,state,'感想の回答');state=await f.chat('get',{actionId:'article'});
 const follow=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'owner',model:'local-model',text:'前の記事との関係を教えて',articleSegmentId:state.activeArticleSegmentId});
 assert.equal(follow.messages.length,4);assert.equal(JSON.stringify(follow.messages).split('SUM-A2').length-1,1);assert.ok(follow.messages[2].content.includes('感想の回答'));await complete(f,follow);
 for(const action of ['summary','revision','citations']){
  state=await startArticleAction(f,target,action);assert.ok(!JSON.stringify(state.messages).includes('SUM-A2'));assert.ok(!JSON.stringify(state.messages).includes('SUM-BETA'));await complete(f,state,'対象だけの回答');
 }
 const normal=await f.chat('get');state=await f.chat('start',{epoch:normal.epoch,endpoint:normal.endpoint,owner:'owner',model:'local-model',text:'普通の質問'});
 assert.ok(!JSON.stringify(state.messages).includes('SUM-A2'));assert.ok(!JSON.stringify(state.messages).includes('BODY-TARGET'));
});

test('要約は正常完了時だけ上書きし、生成中の再取り込みは無視して完了後の本文変更を反映する',async()=>{
 const f=await ready(),a=article('n123','作品','初期本文');await summarizeArticle(f,a,'最初の要約');
 const original=f.articleData.current.summaries[0];
 assert.equal(original.sourceHash,require('node:crypto').createHash('sha256').update(JSON.stringify(a)).digest('hex'));
 const unused=await importArticle(f,a);assert.equal(f.articleData.current.summaries[0].summary,'最初の要約');await f.send({type:'article-operation',patch:{operation:'cancel',requestToken:unused}});
 let state=await startArticleAction(f,a,'summary');await f.chat('progress',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'owner',model:'local-model',id:state.active.id,text:'途中の要約'});
 assert.equal(f.articleData.current.summaries[0].summary,'最初の要約');await f.chat('stop',{actionId:'article',owner:'owner',id:state.active.id});
 state=await startArticleAction(f,a,'summary');await complete(f,state,'');assert.equal(f.articleData.current.summaries[0].summary,'最初の要約');
 await complete(f,await startArticleAction(f,a,'summary'),'改訂した要約');assert.equal(f.articleData.current.summaries.length,1);assert.equal(f.articleData.current.summaries[0].summary,'改訂した要約');
 const changed={...a,body:'変更後本文'};const token=await importArticle(f,changed);assert.equal(f.articleData.current.summaries.length,0);
 state=await start(f,token);const newest={...changed,body:'さらに変更した本文'};await importArticle(f,newest);assert.equal(f.articleData.current.articles[0].body,changed.body);await complete(f,state,'変更前本文の要約');assert.equal(f.articleData.current.summaries[0].summary,'変更前本文の要約');const next=await importArticle(f,newest);assert.equal(f.articleData.current.summaries.length,0);
 await complete(f,await start(f,next),'最新本文の要約');assert.equal(f.articleData.current.summaries[0].summary,'最新本文の要約');
 for(const action of ['impression','revision','citations'])await complete(f,await startArticleAction(f,newest,action),'要約以外の回答');
 assert.equal(f.articleData.current.summaries[0].summary,'最新本文の要約');assert.equal(f.articleData.current.articles[0].body,newest.body);
});

test('要約Mapと会話の保存失敗は同時に巻き戻し、再起動後も保持して記事初期化だけでまとめて削除する',async()=>{
 const f=await ready(),a=article(),b=article('n456','別の作品','別本文');await summarizeArticle(f,a,'Aの保存要約');
 const pending=await start(f,await importArticle(f,b)),before=structuredClone(f.articleData);f.fail=true;
 await assert.rejects(complete(f,pending,'Bの要約'),/storage failed/);assert.deepEqual(f.articleData,before);f.fail=false;await complete(f,pending,'Bの保存要約');
 delete f.sessionData[f.context.OshaberiNoteArticles.requestSessionKey];await f.chat('restore');assert.equal(f.articleData.current.summaries.length,2);
 await f.chat('reset',{actionId:'chat'});await f.chat('reset',{actionId:'tag-suggestion-v1'});assert.equal(f.articleData.current.summaries.length,2);
 assert.ok(!f.context.OshaberiNote.exportSettings(await f.settings()).includes('保存要約'));
 await f.chat('reset',{actionId:'article'});assert.deepEqual(f.articleData.current.summaries,[]);assert.deepEqual(f.articleData.current.articles,[]);assert.equal(f.articleData.current.conversation.turns.length,0);
 await summarizeArticle(f,a,'接続先変更前の要約');await f.save({ollamaUrl:'http://localhost:11434'});assert.deepEqual(f.articleData.current.summaries,[]);
});

test('0.1.0の本文と履歴を保持して要約Mapなしから移行し、表示名や特殊な著者IDを取り違えない',async()=>{
 const f=await ready(),a=article();await summarizeArticle(f,a,'旧回答');delete f.articleData.current.summaries;for(const turn of f.articleData.current.conversation.turns)delete turn.articleSourceHash;
 await f.chat('get',{actionId:'article'});assert.deepEqual(f.articleData.current.summaries,[]);assert.equal(f.articleData.current.articles.length,1);assert.equal(f.articleData.current.conversation.turns[0].assistant,'旧回答');
 const special=authored('__proto__','nP1','作品1','特殊ID本文'),other=authored('constructor','nP2','作品2','別の特殊ID本文'),target=authored('__proto__','nP3','作品3','対象本文');
 await summarizeArticle(f,special,'同じ特殊IDの要約');await summarizeArticle(f,other,'別IDの秘密の要約');await importArticle(f,target);
 const state=await startArticleAction(f,target,'impression'),text=JSON.stringify(state.messages);assert.ok(text.includes('同じ特殊IDの要約'));assert.ok(!text.includes('別IDの秘密の要約'));assert.ok(!text.includes('旧回答'));
});

test('同著者要約を件数で間引かず、送信文字数と8MiB保存容量の上限では無言で削除しない',async()=>{
 const f=await ready();for(let i=1;i<=7;i++)await summarizeArticle(f,article('n'+i,'作品'+i,'本文'+i),'要'.repeat(32000));
 const target=article('nTarget','対象','対象本文');await importArticle(f,target);const before=structuredClone(f.articleData);
 await assert.rejects(startArticleAction(f,target,'impression'),/参考情報.*送信上限/);assert.deepEqual(f.articleData,before);assert.equal(f.articleData.current.summaries.length,7);
 const api=f.context.OshaberiNoteArticles,raw=structuredClone(f.articleData.current);raw.summaries[0].summary='a'.repeat(8*1024*1024);assert.throws(()=>api.bounded(raw),/容量上限/);
 const malformed=structuredClone(before.current);malformed.summaries[0].authorId='someone_else';assert.throws(()=>api.read(malformed,malformed.endpoint),/要約と記事の対応/);
});


test('隣のホームから受領応答がない場合は背景タブを作り、受付済み依頼を失わない',async()=>{
 const f=await ready();f.context.chrome.tabs.query=async()=>[{id:8,url:'chrome-extension://test/home.html'}];f.context.chrome.runtime.sendMessage=async()=>{throw Error('No receiver');};
 await importArticle(f);assert.equal(f.opened.length,1);assert.equal(f.opened[0].active,false);assert.equal(Object.keys(f.articleData.current.requests).length,1);
});


function compactArticleUi(){
 const f=articleCopyUi();const header=documentFromHtml('<header data-header-state="navbar"><div><a href="https://note.com/"><svg role="img" aria-label="note"></svg></a></div></header>').root.children[0];f.doc.body.prepend(header);
 const avatar=f.doc.createElement('span');avatar.setAttribute('data-name','avatar');f.doc.getElementById('author').append(avatar);
 let compact=true;f.win.matchMedia=query=>({matches:query==='(min-width: 1100px)'?!compact:true});f.update();
 return {...f,ui:f.doc.querySelector('[class=\"oshaberi-note-article-menu\"]'),header,setCompact:value=>{compact=value;f.update();}};
}

test('狭幅の記事はハンバーガーから同じ操作を使え、開くだけでは送信・コピーせずEscapeで戻る',async()=>{
 const f=compactArticleUi(),toggle=f.doc.querySelector('[class=\"oshaberi-note-mobile-toggle\"]'),panel=f.doc.querySelector('[class=\"oshaberi-note-mobile-panel\"]');
 assert.ok(toggle);assert.equal(toggle.textContent,'☰');assert.equal(panel.hidden,true);assert.deepEqual(f.ui.children.map(n=>n.className),['oshaberi-note-article-following','oshaberi-note-article-author','oshaberi-note-article-author-search','oshaberi-note-article-summary']);
 assert.equal(f.ui.children[0].href,'https://note.com/following');assert.equal(f.ui.children[1].href,'https://note.com/test');assert.ok(f.ui.children[2].href.includes('test'));
 toggle.onclick();assert.equal(panel.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');assert.deepEqual(f.imports,[]);assert.deepEqual(f.copies,[]);
 await f.buttons[0].onclick();assert.equal(f.imports.length,1);assert.equal(panel.hidden,false);await f.buttons[1].onclick();assert.equal(f.copies.length,1);assert.equal(panel.hidden,false);
 panel.onkeydown({key:'Escape',preventDefault(){}});assert.equal(panel.hidden,true);assert.equal(f.doc.activeElement,toggle);assert.equal(toggle.getAttribute('aria-expanded'),'false');
});

test('記事メニューは再描画で増殖せず、前後リンク・URL変更を反映し、狭幅と広幅で操作要素を移す',()=>{
 const f=compactArticleUi(),toggle=f.doc.querySelector('[class=\"oshaberi-note-mobile-toggle\"]'),panel=f.doc.querySelector('[class=\"oshaberi-note-mobile-panel\"]'),button=f.buttons[0];toggle.onclick();f.update();assert.equal(panel.hidden,false);assert.equal(f.doc.querySelectorAll('[class=\"oshaberi-note-mobile-toggle\"]').length,1);
 appendAdjacent(f,'次の記事','/test/n/n456');f.update();const next=f.wrapper.querySelector('[data-oshaberi-note-adjacent="next"]');assert.equal(next.href,'https://note.com/test/n/n456');panel.onclick({target:next});assert.equal(panel.hidden,true);
 f.setCompact(false);assert.equal(f.doc.querySelector('[class=\"oshaberi-note-mobile-toggle\"]'),null);assert.equal(f.wrapper.parentElement,f.doc.body);assert.equal(f.buttons[0],button);
 f.setCompact(true);assert.ok(f.doc.querySelector('[class=\"oshaberi-note-mobile-toggle\"]'));assert.equal(f.doc.querySelectorAll('[class=\"oshaberi-note-article-summary\"]').length,1);const current=f.doc.querySelector('[class=\"oshaberi-note-mobile-panel\"]');f.doc.querySelector('[class=\"oshaberi-note-mobile-toggle\"]').onclick();f.update(article('n456').url);assert.equal(current.hidden,true);assert.ok(!next.hasAttribute('href'));
});

test('狭幅の記事メニューはOFF・離脱・停止で撤去し、公式ヘッダを確認できない場合は作らない',()=>{
 const f=compactArticleUi();const settings=f.f.context.OshaberiNote.defaultSettings();
 f.controller.update({...settings,enabled:false},article().url);assert.equal(f.doc.querySelector('[class="oshaberi-note-mobile-toggle"]'),null);f.update();assert.ok(f.doc.querySelector('[class="oshaberi-note-mobile-toggle"]'));
 f.header.remove();f.update();assert.equal(f.doc.querySelector('[class=\"oshaberi-note-mobile-toggle\"]'),null);assert.equal(f.doc.querySelector('[class=\"oshaberi-note-article-summary\"]'),null);
 f.doc.body.prepend(f.header);f.update();assert.ok(f.doc.querySelector('[class=\"oshaberi-note-mobile-toggle\"]'));f.update('https://note.com/test');assert.equal(f.doc.querySelector('[class=\"oshaberi-note-article-menu\"]'),null);
});


test('記事ハンバーガー内のTLも現在の公式ヘッダで切り替え、判定不能とOFFでは元へ戻る',()=>{
 const f=compactArticleUi(),header=f.doc.createElement('header'),nav=f.doc.createElement('nav');header.setAttribute('data-header-state','navbar');nav.setAttribute('aria-label','アカウント');header.append(nav);
 for(const [href,text]of [['/login','ログイン'],['/signup','会員登録']]){const a=f.doc.createElement('a');a.href=href;a.textContent=text;nav.append(a);}f.doc.body.prepend(header);f.controller.invalidatePaidCards();f.update();
 const link=f.doc.querySelector('a[data-oshaberi-note-following]'),panel=f.doc.querySelector('[class="oshaberi-note-mobile-panel"]');assert.ok(panel.contains(link));assert.equal(link.href,'https://note.com/search?q=&context=note&mode=search&sort=new');assert.equal(link.textContent,'フォロー中のTL');assert.equal(link.getAttribute('title'),'未ログインのため検索画面を開きます');
 nav.hidden=true;link.fire('contextmenu',{button:2});assert.equal(link.href,'https://note.com/following');nav.hidden=false;f.controller.invalidatePaidCards();f.update();assert.ok(link.href.includes('/search?'));
 f.controller.update({...f.f.context.OshaberiNote.defaultSettings(),enabled:false},article().url);assert.equal(link.href,'https://note.com/following');assert.equal(link.isConnected,false);f.controller.stop();link.fire('click');assert.equal(link.href,'https://note.com/following');
});
