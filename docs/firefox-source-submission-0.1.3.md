# Firefox 0.1.3 ソース提出

アドオン本体は `dist/OshaberiNote-0.1.3-firefox.zip`、審査用ソースは `dist/OshaberiNote-0.1.3-firefox-source.zip` です。ソースZIPをアドオン本体として提出しないでください。

ソースZIPはローカルタグ `0.1.3` の追跡ファイルから作成します。ルートのREADME_BUILDING.mdにコミットIDと再現手順を記載し、配布物へコピーするテキストの改行コードを本体と揃えます。設定JSON・会話・記事データ・一時ファイル・.git・distは含めません。

展開先でNode.js 24.xを使い、次を実行します。npm install、ネットワーク通信、APIキー、Ollamaはビルドには不要です。

```text
node scripts/package.mjs firefox
node verify-firefox-build.mjs
```

出力先は `dist/OshaberiNote-0.1.3-firefox/` です。検証スクリプトは提出本体の全29ファイルについて一覧とSHA-256を照合します。ZIPコンテナ自体はタイムスタンプ等でハッシュが変わり得ますが、展開したファイルは完全一致する必要があります。

ストアへの本体・ソースの提出は利用者が行います。タグとmain／developはGitHubへ反映し、GitHub Releaseの公開・ストア送信はこの作業では行いません。
