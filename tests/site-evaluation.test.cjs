const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { documentFromHtml } = require('./helpers/dom.cjs');

async function verifyArticleCollection(interruption) {
  const document = documentFromHtml(fs.readFileSync(path.join(__dirname, '../home.html'), 'utf8'));
  const byId = id => document.getElementById(`evaluation-${id}`);
  const authorUrl = 'https://note.com/creator';
  const first = `${authorUrl}/n/n123`, second = `${authorUrl}/n/n234`;
  const visited = [];
  const navigations = [];
  const delays = [];
  let releaseDelay, clearedDelay, staleTab, headerReady = false;
  let tab;
  const chrome = { tabs: {
    getCurrent: async () => ({ windowId: 7, index: 2 }),
    async create(options) {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { url: authorUrl, windowId: 7, index: 3, active: false });
      assert.equal(tab, undefined);
      return (tab = { id: 8, status: 'complete', url: options.url });
    },
    async get(id) {
      assert.equal(id, 8);
      if (visited.at(-1) === first) {
        if (interruption === 'closed') throw new Error('No tab');
        if (interruption === 'moved') return { ...tab, url: 'https://note.com/other' };
      }
      if (staleTab) {
        const previous = staleTab;
        staleTab = undefined;
        return previous;
      }
      return tab;
    },
    async update(id, { url }) {
      assert.equal(id, 8);
      if (url === second) assert.equal(byId('results').querySelectorAll('details').length, 1);
      if (url === second && (!interruption || interruption === 'cancelled')) staleTab = { ...tab };
      navigations.push(url);
      tab.url = url;
    },
    async sendMessage(id, { url, kind }) {
      assert.equal(id, 8);
      assert.equal(url, tab.url);
      if (url === second && !headerReady) return { waiting: true, error: 'ヘッダー待ち' };
      visited.push(url);
      return { value: kind === 'profile' ? { authorUrl, name: '作者', candidates: [] } : { title: '記事', body: '<script>記事本文</script>' } };
    }
  } };
  const context = vm.createContext({
    document, chrome, URL, AbortController, addEventListener() {},
    setTimeout(callback, delay) {
      delays.push(delay);
      releaseDelay = callback;
      return delays.length;
    },
    clearTimeout(id) { clearedDelay = id; }
  });
  for (const file of ['common', 'articles', 'site-evaluation-source', 'site-evaluation-ui']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/${file}.js`), 'utf8'), context);
  }
  byId('target').value = 'creator';
  await byId('profile').onclick();
  const [one, two] = byId('articles').querySelectorAll('input');
  one.value = first;
  two.value = 'https://note.com/other/n/n234';
  await byId('collect').onclick();
  assert.deepEqual(visited, [authorUrl]);
  assert.match(byId('status').textContent, /対象作者/);
  two.value = second;
  const collection = byId('collect').onclick();
  await new Promise(resolve => setImmediate(resolve));
  if (!interruption || interruption === 'cancelled') {
    assert.deepEqual(delays, [400]);
    assert.deepEqual(navigations, [first, second]);
    assert.deepEqual(visited, [authorUrl, first]);
    releaseDelay();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delays, [400, 400]);
    assert.deepEqual(visited, [authorUrl, first]);
    if (interruption === 'cancelled') byId('cancel').onclick();
    else { headerReady = true; releaseDelay(); }
  } else assert.deepEqual(delays, []);
  await collection;
  assert.deepEqual(visited, interruption ? [authorUrl, first] : [authorUrl, first, second]);
  assert.deepEqual(navigations, ['closed', 'moved'].includes(interruption) ? [first] : [first, second]);
  assert.equal(byId('results').querySelectorAll('details').length, interruption ? 1 : 2);
  assert.match(byId('results').textContent, /<script>記事本文<\/script>/);
  assert.equal(byId('results').querySelector('script'), null);
  if (interruption === 'cancelled') {
    assert.equal(clearedDelay, 2);
    assert.match(byId('status').textContent, /取得を中止/);
  } else if (interruption) {
    assert.match(byId('status').textContent, /「公開プロフィールを取得」からやり直し/);
    assert.equal(byId('collect').disabled, true);
  }
}

test('サイト評価は右隣の取得タブ1つで対象作者の記事だけを順次取得する', () => verifyArticleCollection());
test('取得用タブが閉じられた場合は取得済み結果を残して中断する', () => verifyArticleCollection('closed'));
test('取得用タブが別ページへ移った場合は新しいタブを開かない', () => verifyArticleCollection('moved'));
test('次の記事のヘッダー待機中に中止すると取得済み結果だけが残る', () => verifyArticleCollection('cancelled'));

test('公式ヘッダーのnoteロゴが揃うまで本文抽出を保留する', () => {
  const url = 'https://note.com/creator/n/n123', homeUrl = 'chrome-extension://test/home.html';
  const window = {}; window.top = window;
  const anchor = {};
  let listener, extracted = 0, headerReady = false;
  const context = vm.createContext({
    window, URL, location: new URL(url),
    document: { readyState: 'complete', querySelectorAll: selector => selector === 'header a[href]' ? [anchor] : [] },
    chrome: { runtime: { id: 'test', getURL: () => homeUrl, onMessage: { addListener: fn => { listener = fn; } } } },
    OshaberiNote: {}, OshaberiNoteArticles: { extract: () => { extracted++; return { title: '記事' }; } },
    OshaberiNoteUi: { isOfficialHeaderLogo: node => node === anchor && headerReady }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/site-evaluation-source.js'), 'utf8'), context);
  const read = () => {
    let response;
    listener({ type: 'site-evaluation-read', kind: 'article', url }, { id: 'test', url: homeUrl }, value => { response = value; });
    return response;
  };
  assert.equal(read().waiting, true);
  assert.equal(extracted, 0);
  headerReady = true;
  assert.equal(read().value.title, '記事');
  assert.equal(extracted, 1);
});

test('7タブから補足付きで個別評価と総評を実行し、感想戦では選んだ原文だけを添付する', async () => {
  const document = documentFromHtml(fs.readFileSync(path.join(__dirname, '../home.html'), 'utf8'));
  const byId = id => document.getElementById(`evaluation-${id}`);
  const authorUrl = 'https://note.com/creator', endpoint = 'http://127.0.0.1:11434';
  const calls = [], copies = [];
  let tab, available = false, allowArticle = false, articleGranted = false, connectionChecks = 0;
  const permissionRequests = [];
  const chrome = {
    tabs: {
      getCurrent: async () => ({ windowId: 7, index: 2 }),
      create: async ({ url }) => (tab = { id: 8, status: 'complete', url }),
      get: async () => tab,
      update: async (id, { url }) => { assert.equal(id, 8); tab.url = url; },
      sendMessage: async (id, { kind, url }) => {
        assert.equal(id, 8); assert.equal(tab.url, url);
        const articleId = url.split('/').at(-1);
        return { value: kind === 'profile' ? { authorUrl, name: '作者', candidates: [] }
          : { url, articleId, title: `題 ${articleId}`, author: '作者', body: `本文 ${articleId}` } };
      }
    },
    runtime: {
      getManifest: () => ({ browser_specific_settings: { gecko: {} } }),
      sendMessage: async () => { connectionChecks++; return { ok: true, settings: { approvedUrl: endpoint } }; }
    },
    permissions: {
      async request(request) {
        permissionRequests.push(JSON.parse(JSON.stringify(request)));
        articleGranted = allowArticle;
        return articleGranted;
      },
      contains: async ({ data_collection }) => !data_collection?.includes('websiteContent') || articleGranted
    }
  };
  const context = vm.createContext({ document, chrome, URL, AbortController, AbortSignal, addEventListener() {},
    navigator: { clipboard: { writeText: async text => { copies.push(text); } } },
    OshaberiNoteChatState: { limits: { context: 256000 } },
    OshaberiNotePlatform: { load: async () => ({ enabled: true, ollamaUrl: endpoint, ollamaModel: 'test' }), subscribe() {} },
    OshaberiNoteOllama: { withGeneration: async task => {
      if (!available) throw new Error('別の画面で応答を生成中です。');
      await task(async (url, model, messages, signal, onText, options) => {
        assert.equal(url, endpoint); assert.equal(model, 'test'); assert.equal(options.truncate, false);
        const data = JSON.parse(messages[1].content); calls.push(data);
        if (data.reviews) return JSON.stringify({ summary: '総評の本文', detail: '選定理由', representatives: ['n234'] });
        if (data.question) return '補足文案を提案します。';
        return '個別所見';
      });
    } }
  });
  for (const file of ['common', 'articles', 'site-evaluation-source', 'site-evaluation-ui']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/${file}.js`), 'utf8'), context);
  }
  assert.deepEqual(byId('tabs').children.map(button => button.textContent), ['取得情報', '記事選択', '補足情報入力', 'サイト評価結果', 'サイト評価詳細', '感想戦', '評価プロンプト']);
  assert.equal(byId('run').disabled, true);
  byId('target').value = authorUrl;
  await byId('profile').onclick();
  const slots = byId('articles').querySelectorAll('input');
  for (const [i, articleId] of ['n123', 'n234', 'n345'].entries()) slots[i].value = `${authorUrl}/n/${articleId}`;
  await byId('collect').onclick();
  byId('tab-notes').onclick();
  byId('notes').value = '記事外の実績は未確認'; byId('notes').oninput();
  assert.deepEqual(permissionRequests, []);
  const denied = byId('run').onclick();
  assert.deepEqual(permissionRequests, [{ data_collection: ['websiteContent'] }]);
  await denied;
  assert.equal(connectionChecks, 0);
  assert.match(byId('status').textContent, /記事本文の送信が許可されませんでした/);
  assert.equal(byId('notes').value, '記事外の実績は未確認');
  assert.equal(calls.length, 0);
  allowArticle = true;
  await byId('run').onclick();
  assert.match(byId('status').textContent, /別の画面/);
  assert.equal(calls.length, 0);
  available = true;
  await byId('run').onclick();
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(0, 3).map(call => call.article.body), ['本文 n123', '本文 n234', '本文 n345']);
  assert.ok(calls.every(call => call.notes === '記事外の実績は未確認'));
  assert.ok(!JSON.stringify(calls[3]).includes('本文 n123'));
  assert.match(byId('result').textContent, /総評の本文[\s\S]*題 n234/);
  assert.equal(byId('run').disabled, true);
  byId('tab-discussion').onclick();
  byId('question').value = '着眼点の見落としは？'; byId('question').oninput();
  byId('reference').value = `${authorUrl}/n/n123`;
  await byId('discuss').onclick();
  assert.equal(calls[4].article.body, '本文 n123');
  assert.equal(byId('reference').value, '');
  await byId('copy-all').onclick();
  assert.doesNotMatch(copies[0], /補足文案/);
  byId('copy-discussion').checked = true;
  await byId('copy-all').onclick();
  assert.match(copies[1], /補足文案/);
  assert.match(byId('result').textContent, /総評の本文/);
  byId('notes').value = '新しい観点'; byId('notes').oninput();
  assert.equal(byId('run').disabled, false);
  assert.match(byId('result').textContent, /現在の条件では未評価/);
});
