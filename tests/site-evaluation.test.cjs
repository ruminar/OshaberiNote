const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { documentFromHtml } = require('./helpers/dom.cjs');

test('サイト評価は右隣の取得タブ1つで対象作者の記事だけを順次取得する', async () => {
  const document = documentFromHtml(fs.readFileSync(path.join(__dirname, '../home.html'), 'utf8'));
  const byId = id => document.getElementById(`evaluation-${id}`);
  const authorUrl = 'https://note.com/creator';
  const first = `${authorUrl}/n/n123`, second = `${authorUrl}/n/n234`;
  const visited = [];
  let tab;
  const chrome = { tabs: {
    getCurrent: async () => ({ windowId: 7, index: 2 }),
    async create(options) {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { url: authorUrl, windowId: 7, index: 3, active: false });
      assert.equal(tab, undefined);
      return (tab = { id: 8, status: 'complete', url: options.url });
    },
    async get(id) { assert.equal(id, 8); return tab; },
    async update(id, { url }) { assert.equal(id, 8); tab.url = url; },
    async sendMessage(id, { url, kind }) {
      assert.equal(id, 8);
      assert.equal(url, tab.url);
      visited.push(url);
      return { value: kind === 'profile' ? { authorUrl, name: '作者', candidates: [] } : { title: '記事', body: '<script>記事本文</script>' } };
    }
  } };
  const context = vm.createContext({ document, chrome, URL, AbortController, addEventListener() {} });
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
  await byId('collect').onclick();
  assert.deepEqual(visited, [authorUrl, first, second]);
  assert.equal(byId('results').querySelectorAll('details').length, 2);
  assert.match(byId('results').textContent, /<script>記事本文<\/script>/);
  assert.equal(byId('results').querySelector('script'), null);
});
