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

test('同名の記事A/Bを保持しながら、各操作は対象記事1件だけの独立リクエストにする',async()=>{
 const f=await ready(),a=article('n123','同名','記事Aの本文'),b=article('n456','同名','記事Bの本文');
 await complete(f,await start(f,await importArticle(f,a)),'Aの要約');await complete(f,await start(f,await importArticle(f,b)),'Bの要約');
 let state=await f.chat('get',{actionId:'article'});
 state=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text:'感想',articleId:a.articleId,articleAction:'impression'});
 assert.ok(state.messages.at(-1).content.includes(a.body));assert.ok(!state.messages.at(-1).content.includes(b.body));assert.match(state.messages.at(-1).content,/感想/);
 assert.deepEqual(state.messages.map(m=>m.role),['system','user']);assert.ok(state.messages.every(m=>!m.content.includes(b.body)&&!m.content.includes('Aの要約')&&!m.content.includes('Bの要約')&&!m.content.includes('[&同名]')));
 await complete(f,state);state=await f.chat('get',{actionId:'article'});
 const follow=await f.chat('start',{actionId:'article',epoch:state.epoch,endpoint:state.endpoint,model:'local-model',owner:'owner',text:'根拠を詳しく',articleSegmentId:state.turns.at(-1).articleSegmentId});
 assert.ok(follow.messages[1].content.includes(a.body));assert.equal(follow.turns.at(-1).user,'根拠を詳しく');
 assert.deepEqual(follow.messages.map(m=>m.role),['system','user','assistant','user']);assert.ok(follow.messages.every(m=>!m.content.includes(b.body)&&!m.content.includes('Aの要約')&&!m.content.includes('Bの要約')));
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
 for(let i=0;i<120;i++)record.conversation.turns.push({...template,user:'質問'+i,assistant:'回答'+i,articleAction:'question'});
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
