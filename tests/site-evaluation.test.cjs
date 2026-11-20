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
