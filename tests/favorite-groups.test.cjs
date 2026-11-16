"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {documentFromHtml}=require('./helpers/dom.cjs'),homeFixture=require('./helpers/home.cjs');
const source=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8'),plain=v=>JSON.parse(JSON.stringify(v)),flush=()=>new Promise(r=>setImmediate(r));
function fixture(initial={}) {
 const c=vm.createContext({URL,console});for(const file of ['common','routing','chat-actions'])vm.runInContext(source(`src/${file}.js`),c);
 const core=c.OshaberiNote;let stored={...plain(core.defaultSettings()),...initial},writes=0,fail=false;
 const restart=()=>c.OshaberiNoteRouting.createController({load:async()=>stored,store:async value=>{if(fail)throw Error('write failed');stored=plain(value);writes++;},setRules:async()=>{}});
 return {c,core,controller:restart(),restart,get stored(){return stored;},get writes(){return writes;},set fail(value){fail=value;}};
}
const own=settings=>JSON.stringify({format:'oshaberi-note-settings',schemaVersion:1,settings});
const article={type:'article',articleId:'n123',url:'https://note.com/sample/n/n123',title:'Sample'};

test('初期値と旧4グループを維持し、2段へ反復移行しても登録内容を失わない',async()=>{
 const f=fixture();assert.equal((await f.controller.getState()).favoriteGroupDisplay,'normal');assert.equal(f.writes,0);
 await f.controller.tag({type:'ADD_TAG',groupId:'group1',tag:'old'});
 const selected=await f.controller.tag({type:'SELECT_TAG_GROUP',groupId:'group4'});
 const value=await f.controller.save({favoriteGroupDisplay:'double'});
 assert.equal(value.tagGroups.length,8);assert.equal(value.tagSchemaVersion,7);assert.equal(value.selectedTagGroupId,'group4');
 assert.equal(value.groupSelectionRevision,selected.groupSelectionRevision);assert.deepEqual(plain(value.tagGroups[0].tags),['old']);
 const before=plain(f.stored.tagGroups);await f.controller.save({favoriteGroupDisplay:'double'});assert.deepEqual(f.stored.tagGroups,before);
 const restarted=await f.restart().getState();assert.equal(restarted.favoriteGroupDisplay,'double');assert.deepEqual(plain(restarted.tagGroups),before);
});

test('後半を非表示にしても名前と項目順を保持し、選択だけ①へ戻して更新番号を進める',async()=>{
 const f=fixture();await f.controller.save({favoriteGroupDisplay:'double'});
 for(const tag of ['one','two'])await f.controller.tag({type:'ADD_TAG',groupId:'group8',tag});
 await f.controller.tag({type:'RENAME_TAG_GROUP',groupId:'group8',name:'後半',expectedName:''});
 const selected=await f.controller.tag({type:'SELECT_TAG_GROUP',groupId:'group8'}),groups=plain(f.stored.tagGroups);
 const value=await f.controller.save({favoriteGroupDisplay:'normal'});
 assert.equal(value.selectedTagGroupId,'group1');assert.equal(value.groupSelectionRevision,selected.groupSelectionRevision+1);
 assert.equal(f.core.availableGroups(value).length,4);assert.deepEqual(f.stored.tagGroups,groups);
 await f.controller.save({favoriteGroupDisplay:'double'});assert.deepEqual(f.stored.tagGroups,groups);assert.equal((await f.restart().getState()).selectedTagGroupId,'group1');
});

test('非表示グループの全操作と移動先を拒否し、別画面の表示変更直後も書き込まない',async()=>{
 const f=fixture();await f.controller.save({favoriteGroupDisplay:'double'});await f.controller.tag({type:'ADD_TAG',groupId:'group5',tag:'keep'});
 await f.controller.tag({type:'ADD_TAG',groupId:'group1',tag:'front'});await f.controller.save({favoriteGroupDisplay:'normal'});
 const before=JSON.stringify(f.stored),writes=f.writes;
 for(const operation of [
  {type:'ADD_TAG',groupId:'group5',tag:'new'}, {type:'SELECT_TAG_GROUP',groupId:'group8'},
  {type:'RENAME_TAG_GROUP',groupId:'group5',name:'bad',expectedName:''}, {type:'REMOVE_TAG',groupId:'group5',tag:'keep'},
  {type:'MOVE_TAG',groupId:'group5',tag:'keep',beforeTag:null}, {type:'TRANSFER_TAG',groupId:'group5',targetGroupId:'group1',tag:'keep'},
  {type:'TRANSFER_TAG',groupId:'group1',targetGroupId:'group5',tag:'front'}
 ])await assert.rejects(f.controller.tag(operation),{code:'MODE_RESTRICTED'});
 assert.equal(f.writes,writes);assert.equal(JSON.stringify(f.stored),before);
});

test('5種の登録対象を後半で追加・並べ替え・移動・削除し、非表示の記事重複も防ぐ',async()=>{
 const f=fixture();await f.controller.save({favoriteGroupDisplay:'double'});
 const common={validateCurrent:async()=>true,currentUser:'sample'};
 await f.controller.tag({type:'ADD_TAG',groupId:'group5',tag:'Tag'});
 await f.controller.tag({type:'ADD_USER',groupId:'group5',userId:'sample',displayName:'Author'},common);
 await f.controller.tag({type:'ADD_MAGAZINE',groupId:'group6',userId:'sample',magazineId:'m123',displayName:'Magazine'},{...common,currentMagazineId:'m123'});
 await f.controller.tag({type:'ADD_MEMBERSHIP',groupId:'group7',userId:'sample',displayName:'Membership'},{...common,currentMembership:true});
 const {type,...fields}=article,operation={type:'ADD_ARTICLE',groupId:'group8',...fields},opts={validateCurrent:async()=>true,currentArticleId:article.articleId,currentArticleUrl:article.url};
 await f.controller.tag(operation,opts);
 await f.controller.tag({type:'MOVE_TAG',groupId:'group5',tag:'Tag',beforeTag:null});assert.equal(f.stored.tagGroups[4].tags[1],'Tag');
 await f.controller.tag({type:'TRANSFER_TAG',groupId:'group5',targetGroupId:'group6',tag:'Tag'});assert.equal(f.stored.tagGroups[5].tags[1],'Tag');
 await f.controller.tag({type:'REMOVE_TAG',groupId:'group6',tag:'Tag'});assert.equal(f.stored.tagGroups[5].tags.length,1);
 await f.controller.save({favoriteGroupDisplay:'normal'});await assert.rejects(f.controller.tag({...operation,groupId:'group1'},opts),{code:'CONFLICT'});
 assert.equal((await f.restart().getState()).tagWarning,undefined);
});

test('8グループJSONを表示と独立に往復し、旧4グループ入力で後半を消さない',async()=>{
 const f=fixture();await f.controller.save({favoriteGroupDisplay:'double'});await f.controller.tag({type:'ADD_TAG',groupId:'group8',tag:'back'});
 const state=await f.controller.save({favoriteGroupDisplay:'normal'}),json=f.core.exportSettings(state),doc=JSON.parse(json);
 assert.equal(doc.schemaVersion,1);assert.equal(doc.settings.favoriteGroupDisplay,'normal');assert.equal(doc.settings.tagGroups.length,8);assert.deepEqual(doc.settings.tagGroups[7].items,[{type:'tag',tag:'back'}]);
 assert.deepEqual(plain(f.core.parseSettingsExport(json).tagGroups),plain(state.tagGroups));
 const old=doc.settings.tagGroups.slice(0,4);old[0].items=[{type:'tag',tag:'new'}];
 const imported=f.core.parseSettingsExport(own({tagGroups:old}),state);
 assert.equal(imported.tagGroups.length,8);assert.deepEqual(plain(imported.tagGroups[7].tags),['back']);assert.deepEqual(plain(imported.tagGroups[0].tags),['new']);
 const partial=f.core.parseSettingsExport(own({tagGroups:[{id:'group8',name:'',items:[]}]}),state);assert.deepEqual(plain(partial.tagGroups[7].tags),[]);
 const reordered=f.core.parseSettingsExport(own({tagGroups:[...doc.settings.tagGroups].reverse()}),state);assert.equal(reordered.tagGroups[0].id,'group1');
 await f.controller.importSettings({json:own({tagGroups:old}),expectedToken:f.core.settingsToken(state)});assert.deepEqual(f.stored.tagGroups[7].tags,['back']);
});

test('ひきこもりnote JSON9の8グループを読み、製品固有モードは表示設定にのみ対応付ける',()=>{
 const f=fixture(),groups=f.core.groupIds.map(id=>({id,name:'',items:[]}));groups[7].items=[article];
 const json=mode=>JSON.stringify({format:'hikikomori-note-settings',schemaVersion:9,settings:{mode,tagGroups:groups,selectedTagGroupId:'group8',ollamaUrl:'http://invalid.test'}});
 const value=f.core.parseSettingsExport(json('normal-double'));assert.equal(value.favoriteGroupDisplay,'double');assert.equal(value.selectedTagGroupId,'group8');assert.equal(value.ollamaUrl,'http://127.0.0.1:11434');
 assert.deepEqual(plain(value.tagGroups[7].tags),[article]);const normal=f.core.parseSettingsExport(json('normal'));assert.equal(normal.selectedTagGroupId,'group1');assert.equal(normal.tagGroups.length,8);
 assert.throws(()=>f.core.parseSettingsExport(own({tagGroups:[groups[0],groups[0]]})));
});

test('破損・未知保存形式は保護し、表示変更の失敗時にも旧設定とデータを維持する',async()=>{
 for(const patch of [{tagSchemaVersion:99},{tagSchemaVersion:7}]){
  const f=fixture(patch),before=plain(f.stored.tagGroups);await f.controller.save({favoriteGroupDisplay:'double'});
  assert.deepEqual(f.stored.tagGroups,before);assert.equal(f.stored.tagSchemaVersion,patch.tagSchemaVersion);assert.ok((await f.controller.getState()).tagWarning);
 }
 const f=fixture(),before=JSON.stringify(f.stored);f.fail=true;await assert.rejects(f.controller.save({favoriteGroupDisplay:'double'}));assert.equal(JSON.stringify(f.stored),before);
 f.fail=false;await assert.rejects(f.controller.save({favoriteGroupDisplay:'unknown'}));assert.equal(JSON.stringify(f.stored),before);
});

test('管理画面の表示選択・8グループ編集・移動先を同期し通常へ戻すと①を表示する',async()=>{
 const f=homeFixture(),n=f.nodes;await flush();assert.equal(n.get('favorite-group-display').value,'normal');
 n.get('favorite-group-display').value='double';n.get('favorite-group-display').fire('change');n.get('settings').fire('submit');await flush();
 assert.equal(f.state.tagGroups.length,8);assert.equal(n.get('edit-groups').querySelectorAll('button').length,8);
 n.get('edit-groups').querySelector('[data-group-id="group8"]').onclick();await flush();
 await f.c.OshaberiNotePlatform.tag({type:'ADD_TAG',groupId:'group8',tag:'back'});f.changed({});await flush();
 assert.deepEqual(f.state.tagGroups[7].tags,['back']);assert.equal(n.get('favorite-destination').children.length,8);
 n.get('favorite-group-display').value='normal';n.get('favorite-group-display').fire('change');n.get('settings').fire('submit');await flush();
 assert.equal(f.state.selectedTagGroupId,'group1');assert.equal(n.get('edit-groups').querySelectorAll('button').length,4);assert.deepEqual(f.state.tagGroups[7].tags,['back']);
});

test('公式ページのサイドバーとハンバーガーは同じ8個を使い通常変更で4個へ戻る',async()=>{
 const f=fixture();await f.controller.save({favoriteGroupDisplay:'double'});const state=await f.controller.getState();
 const doc=documentFromHtml('<header data-header-state="navbar"><div><a href="/"><svg role="img" aria-label="note"></svg></a></div></header><aside class="sticky w-[11.375rem]"><div><nav aria-label="急上昇"></nav></div></aside><main><article></article></main>');
 const win={wide:true,matchMedia:q=>({matches:q.includes('max-width')?!win.wide:win.wide}),getComputedStyle:()=>({display:'block'})};
 vm.runInContext(source('src/note-ui.js'),f.c);const ui=f.c.OshaberiNoteUi.create(doc,win,{settingsUrl:()=>'/home.html',selectGroup:async()=>{}});
 const selector=()=>doc.querySelector('[class="oshaberi-note-group-selector"]');
 ui.update(state,'https://note.com/following');assert.equal(selector().children.length,8);assert.equal(selector().getAttribute('data-group-count'),'8');assert.equal(selector().children[7].textContent,'⑧');
 doc.querySelector('aside').width=0;win.wide=false;ui.update(state,'https://note.com/following');assert.ok(selector().closest('[class="oshaberi-note-mobile-panel"]'));assert.equal(selector().children.length,8);
 ui.update({...state,favoriteGroupDisplay:'normal'},'https://note.com/following');assert.equal(selector().children.length,4);ui.stop();
});

test('AIタグ登録ダイアログは設定変更に追従し、旧⑧ボタンからの追加も防ぐ',async()=>{
 const f=fixture();await f.controller.save({favoriteGroupDisplay:'double'});let state=await f.controller.getState();
 const doc=documentFromHtml(source('home.html'));vm.runInContext(source('src/chat-tags.js'),f.c);
 const ui=f.c.OshaberiNoteChatTags.create({document:doc,getSettings:()=>state,platform:{tag:op=>f.controller.tag(op)},onSaved:value=>{state=value;}});
 const output=doc.createElement('div');doc.root.append(output);ui.render(output,'[#Sample]',()=>true);output.querySelector('button').onclick();
 const buttons=doc.getElementById('chat-tag-groups');assert.equal(buttons.children.length,8);const stale=buttons.children[7];stale.onclick();await flush();assert.deepEqual(f.stored.tagGroups[7].tags,['Sample']);
 state=await f.controller.save({favoriteGroupDisplay:'normal'});ui.refresh();assert.equal(buttons.children.length,4);const writes=f.writes;stale.onclick();await flush();assert.equal(f.writes,writes);
});

test('タグ提案は通常表示でも保存した後半グループのタグを最新参考データに含める',async()=>{
 const f=fixture();await f.controller.save({favoriteGroupDisplay:'double'});await f.controller.tag({type:'ADD_TAG',groupId:'group8',tag:'back'});const state=await f.controller.save({favoriteGroupDisplay:'normal'});
 const prompt=f.c.OshaberiNoteChatActions.systemPrompt('tag-suggestion-v1',state);assert.ok(prompt.includes('["back"]'));
});

test('整理画面は手入力欄と行ごとの宛先を撤去し、初回は移動先未選択で始まる',async()=>{
 const f=homeFixture({state:{tagGroups:fixture().core.defaultSettings().tagGroups.map((g,i)=>({...g,tags:i===0?['A','B']:[]}))}});await flush();const n=f.nodes;
 assert.equal(n.has('tag-input'),false);assert.equal(n.has('tag-form'),false);assert.equal(n.get('favorite-destination').value,'');
 assert.equal(n.get('favorite-list').contains(n.get('favorite-destination')),false);
 for(const row of n.get('edit-tags').children){assert.equal(row.querySelector('select'),null);assert.equal(row.querySelectorAll('button').length,4);assert.equal(row.querySelectorAll('button')[3].disabled,true);}
});

test('同じ宛先へ5種類を連続移動し、宛先・スクロール・次のボタンへのフォーカスを維持する',async()=>{
 const f=fixture(),items=['Tag',{type:'user',userId:'sample',displayName:'Author'},{type:'magazine',userId:'sample',magazineId:'m123',displayName:'Magazine'},{type:'membership',userId:'sample',displayName:'Membership'},article];
 const raw=plain(f.core.defaultSettings());raw.tagGroups[0].tags=items;raw.tagSchemaVersion=6;
 const h=homeFixture({state:raw}),n=h.nodes;await flush();n.get('favorite-destination').value='group4';n.get('favorite-destination').fire('change');n.get('favorite-list').scrollTop=180;
 for(let i=0;i<items.length;i++){
  n.get('edit-tags').children[0].querySelectorAll('button')[3].onclick();await flush();
  assert.equal(n.get('favorite-destination').value,'group4');assert.equal(n.get('favorite-list').scrollTop,180);assert.match(n.get('favorite-operation-status').textContent,/④ グループ4へ移動しました/);
  if(i<items.length-1)assert.equal(h.document.activeElement,n.get('edit-tags').children[0].querySelectorAll('button')[3]);else assert.equal(h.document.activeElement,n.get('favorite-list'));
 }
 assert.deepEqual(h.state.tagGroups[3].tags,items);assert.deepEqual(h.state.tagGroups[0].tags,[]);
});

test('移動先が移動元と同じになる切替・非表示化で未選択に戻し、残りの宛先は維持する',async()=>{
 const f=fixture();await f.controller.save({favoriteGroupDisplay:'double'});const h=homeFixture({state:f.stored}),n=h.nodes;await flush();
 const choose=value=>{n.get('favorite-destination').value=value;n.get('favorite-destination').fire('change');};
 choose('group8');n.get('edit-groups').querySelector('[data-group-id="group2"]').onclick();await flush();assert.equal(n.get('favorite-destination').value,'group8');
 n.get('edit-groups').querySelector('[data-group-id="group8"]').onclick();await flush();assert.equal(n.get('favorite-destination').value,'');
 choose('group7');h.changed({favoriteGroupDisplay:'normal'});assert.equal(n.get('favorite-destination').value,'');assert.equal(n.get('favorite-destination').children.length,4);
 h.changed({favoriteGroupDisplay:'double'});assert.equal(n.get('favorite-destination').value,'');
});

test('グループ別の一覧位置は切替と外部同期を経ても保持し、移動先はJSONに含めない',async()=>{
 const h=homeFixture(),n=h.nodes;await flush();n.get('favorite-list').scrollTop=100;
 n.get('edit-groups').querySelector('[data-group-id="group2"]').onclick();await flush();assert.equal(n.get('favorite-list').scrollTop,0);n.get('favorite-list').scrollTop=220;
 n.get('edit-groups').querySelector('[data-group-id="group1"]').onclick();await flush();assert.equal(n.get('favorite-list').scrollTop,100);
 n.get('favorite-destination').value='group3';n.get('favorite-destination').fire('change');h.changed({theme:'dark'});assert.equal(n.get('favorite-list').scrollTop,100);assert.equal(n.get('favorite-destination').value,'group3');
 const exported=JSON.parse(h.c.OshaberiNote.exportSettings(h.state));assert.equal(Object.hasOwn(exported.settings,'favoriteDestination'),false);assert.equal(Object.hasOwn(exported.settings,'favoriteScrolls'),false);
});

test('移動先の重複・保存失敗では元項目を消さず、宛先を保持して成功表示しない',async()=>{
 for(const saveError of [false,true]){
  const raw=plain(fixture().core.defaultSettings());raw.tagGroups[0].tags=['A'];if(!saveError)raw.tagGroups[1].tags=['A'];
  const h=homeFixture({state:raw,saveError}),n=h.nodes;await flush();n.get('favorite-destination').value='group2';n.get('favorite-destination').fire('change');n.get('favorite-list').scrollTop=75;
  n.get('edit-tags').querySelectorAll('button')[3].onclick();await flush();assert.deepEqual(h.state.tagGroups[0].tags,['A']);assert.equal(n.get('favorite-destination').value,'group2');assert.equal(n.get('favorite-list').scrollTop,75);
  assert.match(n.get('favorite-operation-status').textContent,/処理できませんでした/);assert.doesNotMatch(n.get('favorite-operation-status').textContent,/へ移動しました/);
 }
});

test('お気に入りの移動中と成功時は右側だけ通知し、左メニューの状態文を変更しない',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),raw=plain(fixture().core.defaultSettings());raw.tagGroups[0].tags=['Sample'];
 const h=homeFixture({state:raw,saveGate:gate}),n=h.nodes;await flush();const initial=n.get('status').textContent;
 n.get('favorite-destination').value='group2';n.get('favorite-destination').fire('change');n.get('edit-tags').querySelectorAll('button')[3].onclick();
 assert.equal(n.get('status').textContent,initial);assert.equal(n.get('favorite-operation-status').textContent,'保存しています…');
 release();await flush();assert.equal(n.get('status').textContent,initial);assert.match(n.get('favorite-operation-status').textContent,/Sampleを② グループ2へ移動しました/);
});
