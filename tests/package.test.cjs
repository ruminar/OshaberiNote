"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "..");
const packager = () => import(pathToFileURL(path.join(root, "scripts/package.mjs")).href);
const flush = () => new Promise(resolve => setImmediate(resolve));
test("両ブラウザの日本語メタデータが既存表示のまま解決でき、配布物にも含まれる", async t => {
  const { createManifest, buildPackage } = await packager();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "oshaberi-note-locale-test-"));
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const browser of ["chromium", "firefox"]) {
    const manifest = await createManifest(browser);
    assert.equal(manifest.default_locale, "ja");
    const output = await buildPackage(browser, temp);
    const messages = JSON.parse(await fs.readFile(path.join(output, "_locales", manifest.default_locale, "messages.json"), "utf8"));
    for (const [field, expected] of [
      ["name", "おしゃべりnote"],
      ["description", "noteのホームをOllamaとのおしゃべり画面に置き換え、お気に入りから閲覧できる非公式拡張です。"]
    ]) {
      const match = /^__MSG_(.+)__$/.exec(manifest[field]);
      assert.ok(match, `${field}が言語参照になっていること`);
      assert.equal(messages[match[1]].message, expected);
    }
  }
});
test("FirefoxのManifestだけ背景処理・ID・Android対応・データ収集宣言を変更し、Chromium版は維持", async () => {
  const { createManifest } = await packager();
  const chromium = await createManifest("chromium");
  const firefox = await createManifest("firefox");
  assert.equal(chromium.background.service_worker, "src/background.js");
  assert.equal(chromium.background.scripts, undefined);
  assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(firefox.background.scripts, ["src/common.js", "src/articles.js", "src/article-store.js", "src/chat-actions.js", "src/chat-state.js", "src/platform/browser-api.js", "src/routing.js", "src/background.js"]);
  assert.equal(chromium.browser_specific_settings, undefined);
  assert.equal(firefox.browser_specific_settings.gecko_android, undefined);
  assert.equal(firefox.browser_specific_settings.gecko.id, "oshaberi-note@ruminar");
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"], optional: ["personalCommunications", "websiteContent"] });
  for (const field of ["permissions", "host_permissions", "content_scripts", "web_accessible_resources", "version", "icons"]) assert.deepEqual(firefox[field], chromium[field]);
  await assert.rejects(createManifest("unknown"));
});
test("Firefox Event Page：importScriptsなし・browser名前空間だけで起動、設定・転送・アイコンが動く", async () => {
  const { createManifest } = await packager();
  const manifest = await createManifest("firefox");
  let onMessage, onAction, stored, activeRules, opened;
  const id = manifest.browser_specific_settings.gecko.id;
  const getURL = file => `moz-extension://runtime-uuid/${file}`;
  const event = () => ({ addListener() {} });
  const c = vm.createContext({
    URL, TextEncoder, structuredClone, crypto: require("node:crypto").webcrypto, console: { warn() {} },
    browser: {
      permissions: { onRemoved: event(), contains: async () => false },
      runtime: { id, getURL, onConnect: event(), onMessage: { addListener(fn) { onMessage = fn; } }, onInstalled: event(), onStartup: event() },
      storage: {
        local: { async get(key) { return { [key]: stored }; }, async set(value) { stored = value[Object.keys(value)[0]]; } },
        onChanged: event()
      },
      declarativeNetRequest: { async updateDynamicRules(update) { activeRules = JSON.parse(JSON.stringify(update)); } },
      action: { onClicked: { addListener(fn) { onAction = fn; } } },
      tabs: { async create(options) { opened = options.url; } }
    },
    // Firefoxでchromeも公開されていてもbrowserを優先する。
    chrome: { runtime: { id: "wrong-namespace" } }
  });
  c.browser.storage.session = { get:async()=>({}),set:async()=>{} };
  // Event Pageの起動差分が対象。実IndexedDBはブラウザ試験で検証する。
  for (const file of manifest.background.scripts) {
    if (file === "src/article-store.js") c.OshaberiNoteArticleStore = { get:async()=>undefined,set:async()=>{},remove:async()=>{} };
    else vm.runInContext(await fs.readFile(path.join(root, file), "utf8"), c, { filename: file });
  }
  await flush();
  assert.equal(activeRules.addRules.length, 2);
  assert.deepEqual(activeRules.removeRuleIds, [1, 2, 3, 4]);
  assert.equal(activeRules.addRules[0].action.redirect.extensionPath, "/home.html");
  const response = await new Promise(resolve => {
    assert.equal(onMessage({ type: "save-settings", patch: { enabled: false, noteUserId: "ruminar" } }, { id, url: getURL("home.html") }, resolve), true);
  });
  assert.equal(response.ok, true); assert.equal(stored.enabled, false); assert.equal(stored.noteUserId, "ruminar");
  assert.deepEqual(activeRules.addRules, []);
  assert.equal(onMessage({ type: "get-state" }, { id: "runtime-uuid", url: getURL("home.html") }, () => {}), false);
  onAction(); await flush(); assert.equal(opened, getURL("home.html"));
  assert.equal(stored.enabled, true); assert.equal(stored.noteUserId, "ruminar");
  assert.equal(activeRules.addRules.length, 2);
});
test("両ブラウザの配布フォルダはmanifest直下・必要ファイルのみで再生成可能", async t => {
  const { buildPackage, runtimeFiles } = await packager();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "oshaberi-note-package-test-"));
  // 自テストで作成した一時フォルダだけを後片付けする。
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const browser of ["chromium", "firefox"]) {
    const output = await buildPackage(browser, temp);
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.version, "0.1.1");
    for (const file of [...runtimeFiles, "INSTALL.md"]) assert.ok((await fs.stat(path.join(output, file))).isFile());
    for (const file of manifest.background.scripts ?? [manifest.background.service_worker]) assert.ok((await fs.stat(path.join(output, file))).isFile());
    for (const forbidden of [".git", "tests", "scripts", "README.md"]) await assert.rejects(fs.stat(path.join(output, forbidden)), { code: "ENOENT" });
    await fs.writeFile(path.join(output, "stale.txt"), "old build");
    assert.equal(await buildPackage(browser, temp), output);
    await assert.rejects(fs.stat(path.join(output, "stale.txt")), { code: "ENOENT" });
  }
});


test('Windowsの配布ZIPは生のエントリ名にバックスラッシュを含まず、階層・日本語名・ファイル内容を保つ', {skip:process.platform!=='win32'}, async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'oshaberi-zip-test-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const input=path.join(temp,'payload'),output=path.join(temp,'package.zip');
 const expected=new Map([['manifest.json',Buffer.from('{"version":"0.1.1"}')],['icons/icon128.png',Buffer.from([0,1,2,255])],['src/階層/日本語.txt',Buffer.from('テスト本文')]]);
 for(const [name,bytes]of expected){const file=path.join(input,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
 await require('node:util').promisify(require('node:child_process').execFile)('powershell.exe',['-NoProfile','-File',path.join(root,'scripts/zip.ps1'),'-InputDirectory',input,'-OutputFile',output]);
 const zip=await fs.readFile(output),end=zip.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));assert.ok(end>=0);let offset=zip.readUInt32LE(end+16);const count=zip.readUInt16LE(end+10);assert.equal(count,expected.size);
 for(let i=0;i<count;i++){
  assert.equal(zip.readUInt32LE(offset),0x02014b50);const size=zip.readUInt32LE(offset+20),n=zip.readUInt16LE(offset+28),extra=zip.readUInt16LE(offset+30),comment=zip.readUInt16LE(offset+32),local=zip.readUInt32LE(offset+42);
  const name=zip.subarray(offset+46,offset+46+n).toString('utf8');assert.ok(!name.includes('\\'),name);assert.ok(expected.has(name),name);
  assert.equal(zip.readUInt32LE(local),0x04034b50);const localName=zip.readUInt16LE(local+26),localExtra=zip.readUInt16LE(local+28);assert.equal(zip.subarray(local+30,local+30+localName).toString('utf8'),name);
  const start=local+30+localName+localExtra,packed=zip.subarray(start,start+size),method=zip.readUInt16LE(offset+10);const bytes=method===0?packed:require('node:zlib').inflateRawSync(packed);assert.deepEqual(bytes,expected.get(name));expected.delete(name);offset+=46+n+extra+comment;
 }
 assert.equal(expected.size,0);
});
