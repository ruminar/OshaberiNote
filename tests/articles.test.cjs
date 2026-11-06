const {test}=require('node:test'),assert=require('node:assert/strict');
const backend=require('./helpers/chat.cjs'),{documentFromHtml}=require('./helpers/dom.cjs');
const article=(articleId='n123',title='同じタイトル',body='これは表示できる記事の本文です。')=>({articleId,title,author:'著者',body,url:`https://note.com/test/n/${articleId}`});
async function ready(){const f=backend();f.connect('owner');await f.save({ollamaModel:'local-model'});const state=await f.chat('get');await f.chat('approve',{epoch:state.epoch,endpoint:state.endpoint});return f;}
async function importArticle(f,value=article()){
 f.context.chrome.tabs.get=async()=>({url:value.url});
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
 const f=await ready();await importArticle(f,article('n123','同名','以前の本文'));await importArticle(f,article('n456','同名','別の記事'));
 await importArticle(f,article('n123','変更した題','最新の本文'));
 const values=f.articleData.current.articles;assert.equal(values.length,2);assert.equal(values.find(a=>a.articleId==='n123').body,'最新の本文');assert.equal(values.find(a=>a.articleId==='n456').body,'別の記事');
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
 assert.ok(value.body.includes('タイトル：note作品の題名\n著者：参照先の作者\nURL：https://note.com/other/n/n456'));assert.equal(value.body.split('著者：（著者未取得）').length-1,2);
 const cardAuthor=child.getElementById('card-author');cardAuthor.setAttribute('href','https://note.com/wrong');assert.ok(!f.context.OshaberiNoteArticles.extract(doc,win,article().url).body.includes('参照先の作者'));cardAuthor.setAttribute('href','https://note.com/other');cardAuthor.hidden=true;assert.ok(!f.context.OshaberiNoteArticles.extract(doc,win,article().url).body.includes('参照先の作者'));
 assert.ok(!value.body.includes('説明文は送らない'));assert.ok(!value.body.includes('スキ数は送らない'));
 const state=await start(f,await importArticle(f,value));assert.ok(state.messages.at(-1).content.includes(value.body));
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

test('要約は正常完了時だけ上書きし、本文変更と生成中の再取り込みでは古い要約を登録しない',async()=>{
 const f=await ready(),a=article('n123','作品','初期本文');await summarizeArticle(f,a,'最初の要約');
 const original=f.articleData.current.summaries[0];
 assert.equal(original.sourceHash,require('node:crypto').createHash('sha256').update(JSON.stringify(a)).digest('hex'));
 await importArticle(f,a);assert.equal(f.articleData.current.summaries[0].summary,'最初の要約');
 let state=await startArticleAction(f,a,'summary');await f.chat('progress',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,owner:'owner',model:'local-model',id:state.active.id,text:'途中の要約'});
 assert.equal(f.articleData.current.summaries[0].summary,'最初の要約');await f.chat('stop',{actionId:'article',owner:'owner',id:state.active.id});
 state=await startArticleAction(f,a,'summary');await complete(f,state,'');assert.equal(f.articleData.current.summaries[0].summary,'最初の要約');
 await complete(f,await startArticleAction(f,a,'summary'),'改訂した要約');assert.equal(f.articleData.current.summaries.length,1);assert.equal(f.articleData.current.summaries[0].summary,'改訂した要約');
 const changed={...a,body:'変更後本文'};const token=await importArticle(f,changed);assert.equal(f.articleData.current.summaries.length,0);
 state=await start(f,token);const newest={...changed,body:'さらに変更した本文'};const next=await importArticle(f,newest);await complete(f,state,'変更前本文の要約');assert.equal(f.articleData.current.summaries.length,0);
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
