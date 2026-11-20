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
  for (const file of ['common', 'articles', 'site-evaluation-source', 'site-evaluation-ratings', 'site-evaluation-ui']) {
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
  const document = documentFromHtml('<article id="note-article"><time datetime="2026-11-19T12:00:00+09:00"></time><div id="note-body"><button aria-label="999スキ この記事にスキをつけたユーザーを見る"></button><time datetime="2000-01-01"></time></div><button aria-label="1,234スキ この記事にスキをつけたユーザーを見る"></button></article>');
  const selectAll = document.querySelectorAll.bind(document);
  document.readyState = 'complete';
  document.querySelectorAll = selector => selector === 'header a[href]' ? [anchor] : selectAll(selector);
  let listener, extracted = 0, headerReady = false;
  const context = vm.createContext({
    window, URL, location: new URL(url),
    document,
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
  const { value } = read();
  assert.equal(value.title, '記事');
  assert.equal(Object.hasOwn(value, 'likeCount'), false);
  assert.equal(value.publishedAt, '2026-11-19T12:00:00+09:00');
  assert.equal(extracted, 1);
});

test('7タブから補足付きで個別評価と総評を実行し、感想戦では選んだ原文だけを添付する', async () => {
  const document = documentFromHtml(fs.readFileSync(path.join(__dirname, '../home.html'), 'utf8'));
  const byId = id => document.getElementById(`evaluation-${id}`);
  const authorUrl = 'https://note.com/creator', endpoint = 'http://127.0.0.1:11434';
  const candidates = ['n123', 'n234', 'n345', 'n456', 'n567', 'n678'].map((articleId, i) => ({ articleId, url: `${authorUrl}/n/${articleId}`, title: `題 ${articleId}`, likeCount: [0, 10, 20, 30, 40, 50][i] }));
  const calls = [], copies = [];
  let tab, available = false, allowArticle = false, articleGranted = false, connectionChecks = 0, invalidAssessment = true;
  let tick, now = 0;
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
        return { value: kind === 'profile' ? { authorUrl, name: '作者', candidates }
          : { url, articleId, title: `題 ${articleId}`, author: '作者', body: `本文 ${articleId}`, likeCount: articleId === 'n123' ? 1000 : 22 } };
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
    performance: { now: () => now },
    setInterval(callback, interval) { assert.equal(interval, 1000); tick = callback; return 1; },
    clearInterval(id) { assert.equal(id, 1); tick = undefined; },
    navigator: { clipboard: { writeText: async text => { copies.push(text); } } },
    OshaberiNoteChatState: { limits: { context: 256000 } },
    OshaberiNotePlatform: { load: async () => ({ enabled: true, ollamaUrl: endpoint, ollamaModel: 'test' }), subscribe() {} },
    OshaberiNoteOllama: { withGeneration: async task => {
      if (!available) throw new Error('別の画面で応答を生成中です。');
      await task(async (url, model, messages, signal, onText, options) => {
        assert.equal(url, endpoint); assert.equal(model, 'test'); assert.equal(options.truncate, false);
        const data = JSON.parse(messages[1].content); calls.push(data);
        assert.equal(byId('progress').hidden, false);
        assert.match(byId('progress-detail').textContent, /応答を待っています/);
        if (calls.length === 1) {
          assert.match(byId('status').textContent, /1 \/ 3.*題 n123/);
          now += 2400; tick();
          assert.match(byId('progress-detail').textContent, /0分02秒.*応答を待っています/);
          byId('tab-prompt').onclick();
          assert.equal(byId('progress').hidden, false);
        }
        onText('応答の途中');
        assert.match(byId('progress-detail').textContent, /5文字を受信/);
        if (data.reviews) {
          assert.deepEqual(Array.from(options.format.properties.ratings.required), ['impact', 'reach', 'precision', 'originality']);
          assert.deepEqual(Array.from(options.format.properties.representatives.items.enum), ['n123', 'n234', 'n345']);
          if (invalidAssessment) return 'JSONではない応答';
          return JSON.stringify({ type: '実験型', summary: '総評の本文', features: ['作風'], representatives: ['n234'],
            ratings: { impact: { rank: 'A', reason: '面白い' }, reach: { rank: 'B', reason: '有用' }, precision: { rank: 'C', reason: '読みやすい' }, originality: { rank: '判定不能', reason: '資料不足' } } });
        }
        assert.equal(options.format, undefined);
        if (data.question) return '補足文案を提案します。';
        return '個別所見';
      });
    } }
  });
  for (const file of ['common', 'articles', 'site-evaluation-source', 'site-evaluation-ratings', 'site-evaluation-ui']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/${file}.js`), 'utf8'), context);
  }
  assert.deepEqual(byId('tabs').children.map(button => button.textContent), ['取得情報', '記事選択', '補足情報入力', 'サイト評価結果', 'サイト評価詳細', '感想戦', '評価プロンプト']);
  assert.equal(byId('run').disabled, true);
  byId('target').value = authorUrl;
  await byId('profile').onclick();
  assert.match(byId('profile-name').textContent, /スキ合計150件.*平均25件/);
  const slots = byId('articles').querySelectorAll('input');
  const dropdown = byId('candidate');
  assert.equal(dropdown.value, candidates[0].url);
  byId('add').onclick();
  assert.equal(dropdown.value, candidates[1].url);
  assert.equal(byId('article-title-1').textContent, candidates[0].title);
  assert.ok(!dropdown.children.some(option => option.value === candidates[0].url));
  byId('add').onclick();
  slots[2].value = candidates[2].url + '/'; slots[2].oninput();
  assert.equal(byId('article-title-3').textContent, candidates[2].title);
  assert.deepEqual(dropdown.children.map(option => option.value), candidates.slice(3).map(item => item.url));
  byId('add').onclick(); byId('add').onclick();
  assert.deepEqual(slots.slice(0, 5).map(slot => slot.value.replace(/\/$/, '')), candidates.slice(0, 5).map(item => item.url));
  assert.equal(byId('add').disabled, true);
  slots[4].value = ''; slots[4].oninput();
  assert.equal(byId('article-title-5').textContent, '');
  slots[3].value = `${authorUrl}/n/n999`; slots[3].oninput();
  assert.equal(byId('article-title-4').textContent, '');
  slots[3].value = ''; slots[3].oninput();
  assert.deepEqual(dropdown.children.map(option => option.value), candidates.slice(3).map(item => item.url));
  assert.equal(byId('add').disabled, false);
  await byId('collect').onclick();
  for (const title of byId('results').querySelectorAll('summary')) {
    assert.match(title.textContent, /本文.*投稿日/);
    assert.doesNotMatch(title.textContent, /スキ/);
  }
  byId('tab-notes').onclick();
  byId('notes').value = '記事外の実績は未確認'; byId('notes').oninput();
  assert.deepEqual(permissionRequests, []);
  const denied = byId('run').onclick();
  assert.deepEqual(permissionRequests, [{ data_collection: ['websiteContent'] }]);
  await denied;
  assert.equal(byId('progress').hidden, true);
  assert.equal(tick, undefined);
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
  assert.match(byId('status').textContent, /最後の鑑定からやり直せます/);
  assert.equal(byId('ratings').hidden, true);
  invalidAssessment = false;
  await byId('run').onclick();
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[4], calls[3]);
  assert.equal(byId('progress').hidden, true);
  assert.equal(tick, undefined);
  assert.deepEqual(calls.slice(0, 3).map(call => call.article.body), ['本文 n123', '本文 n234', '本文 n345']);
  assert.ok(calls.slice(0, 3).every(({ article }) => !Object.hasOwn(article, 'scope')));
  assert.ok(calls.every(call => call.notes === '記事外の実績は未確認'));
  assert.ok(!JSON.stringify(calls[3]).includes('本文 n123'));
  assert.match(byId('result').textContent, /総評の本文[\s\S]*題 n234/);
  assert.match(byId('result').textContent, /実験型/);
  assert.deepEqual(byId('rating-rows').children.map(row => row.children[1].textContent), ['A', 'D', 'B', '判定不能', 'C', '判定不能']);
  assert.match(byId('detail').textContent, /一覧 6本のスキ合計150件 ÷ 6本で、平均25件/);
  assert.equal(byId('run').disabled, true);
  byId('tab-discussion').onclick();
  byId('question').value = '着眼点の見落としは？'; byId('question').oninput();
  byId('reference').value = `${authorUrl}/n/n123`;
  await byId('discuss').onclick();
  assert.equal(calls[5].article.body, '本文 n123');
  assert.equal(byId('reference').value, '');
  await byId('copy-all').onclick();
  assert.doesNotMatch(copies[0], /補足文案/);
  byId('copy-discussion').checked = true;
  await byId('copy-all').onclick();
  assert.match(copies[1], /補足文案/);
  assert.match(byId('result').textContent, /総評の本文/);
  byId('notes').value = '新しい観点'; byId('notes').oninput();
  assert.equal(byId('run').disabled, false);
  assert.match(byId('result-meta').textContent, /現在の条件では未評価/);
});

test('能力鑑定は投稿頻度の境界と資料不足を区別し、LLMの不正なランクやIDを拒否する', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/site-evaluation-ratings.js'), 'utf8'), context);
  const rating = context.OshaberiNoteEvaluationRatings;
  const now = Date.parse('2026-11-20T00:00:00Z');
  const date = days => new Date(now - days * 86400000).toISOString();
  const posts = count => [...Array.from({ length: count }, (_, i) => date(i)), date(57)];
  for (const [count, rank] of [[56, 'A'], [16, 'B'], [8, 'C'], [7, 'D']]) assert.equal(rating.stamina(posts(count), now).rank, rank);
  assert.equal(rating.stamina([date(60), date(61)], now).rank, 'E');
  assert.equal(rating.stamina([date(1), date(2)], now).rank, '判定不能');
  assert.equal(rating.stamina([date(2), date(1), date(60)], now).rank, '判定不能');
  assert.equal(rating.speed([{ likeCount: 0 }]).rank, 'E');
  assert.equal(rating.speed([{ likeCount: 0 }, { likeCount: null }]).rank, '判定不能');
  assert.equal(rating.speed([{ likeCount: null }]).rank, '判定不能');
  const a = { rank: 'A', reason: '記事に根拠あり' }, result = { type: '作家', summary: '総評', features: [], representatives: ['n123'], ratings: { impact: a, reach: a, precision: a, originality: a } };
  assert.equal(rating.parse(JSON.stringify(result), ['n123']).type, '作家');
  assert.throws(() => rating.parse(JSON.stringify({ ...result, representatives: ['n999'] }), ['n123']));
  assert.throws(() => rating.parse(JSON.stringify({ ...result, ratings: { ...result.ratings, speed: a } }), ['n123']));
  assert.throws(() => rating.parse(JSON.stringify({ ...result, ratings: { ...result.ratings, impact: { rank: 'S', reason: '不正' } } }), ['n123']));
});

test('プロフィールでCSS非表示にしたスキ数も記事カードから取得し、重複記事を1件として扱う', () => {
  const authorUrl = 'https://note.com/creator';
  const card = (id, contents) => `<div class="flex w-full bg-surface-normal flex-col"><a href="${authorUrl}/n/${id}" title="記事"></a><div><div class="mt-2 flex items-center gap-2 text-sm">${contents}</div></div></div>`;
  const counter = count => `<div class="flex items-center justify-center gap-1 text-text-like"><svg role="img" data-id="Icon" aria-label="スキの数"></svg><span class="text-sm" data-test-count="${count}"></span></div>`;
  const buttons = '<div class="flex items-center justify-center"><button type="button" aria-pressed="false"><svg role="img" data-id="Icon" aria-label="スキ"></svg></button><button id="count-button" aria-label="7スキ この記事にスキをつけたユーザーを見る"></button></div>';
  const document = documentFromHtml(`<link rel="canonical" href="${authorUrl}"><h1></h1><main id="main-content"><h2></h2>${card('n123', counter('0'))}${card('n123', counter('0'))}${card('n234', counter('1,234'))}${card('n345', counter('1.2万'))}${card('n456', buttons)}</main>`);
  document.querySelector('h1').textContent = '作者';
  document.querySelector('h2').textContent = '記事一覧';
  const hidden = 'oshaberi-note-profile-like-hidden';
  for (const node of document.querySelectorAll('h1, h2, a[href], span')) node.getClientRects = () => node.classList.contains(hidden) ? [] : [{}];
  for (const node of document.querySelectorAll('span')) {
    node.textContent = node.getAttribute('data-test-count');
  }
  const button = document.getElementById('count-button');
  button.textContent = '7';
  const context = vm.createContext({ URL });
  for (const file of ['common', 'routing', 'articles', 'note-ui', 'site-evaluation-source']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../src/${file}.js`), 'utf8'), context);
  const win = { matchMedia: () => ({ matches: true }), getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  const ui = context.OshaberiNoteUi.create(document, win, {});
  const settings = { ...context.OshaberiNote.defaultSettings(), hideLikeCounts: true };
  ui.update(settings, authorUrl);
  assert.ok(button.classList.contains(hidden));
  assert.equal(button.textContent, '7');
  assert.ok([...document.querySelectorAll('[data-test-count]')].every(node => node.classList.contains(hidden)));
  const result = context.OshaberiNoteEvaluationSource.readProfile(document, win, authorUrl);
  assert.deepEqual(Array.from(result.candidates, item => [item.articleId, item.likeCount]), [['n123', 0], ['n234', 1234], ['n345', null], ['n456', 7]]);
  ui.update({ ...settings, hideLikeCounts: false }, authorUrl);
  assert.equal(button.classList.contains(hidden), false);
  assert.equal(document.querySelectorAll(`.${hidden}`).length, 0);
});
