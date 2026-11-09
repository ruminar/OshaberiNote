# Firefox 0.1.1 ソース提出

実行用アドオンは `dist/OshaberiNote-0.1.1-firefox.zip`、ソース提出用は `dist/OshaberiNote-0.1.1-firefox-source.zip` です。ソースZIPをアドオン本体としてアップロードしないでください。

ソースZIPはリリースコミットのGit管理ファイルを基に作成し、README_BUILDING.md、firefox-payload-sha256.json、verify-firefox-build.mjsを追加します。本文・設定・会話・一時ファイル・Git管理情報・生成済みdistは含めません。改行コードによる差を避けるため、実行用ファイルは配布物と同じバイト列で収録します。

## 審査担当者への説明

```text
ソースZIPはおしゃべりnote 0.1.1タグのソースに対応します。ルートのREADME_BUILDING.mdにコミットIDと、日本語・英語の再現手順を記載しています。

Node.js 24.xを用意し、展開したソースのルートで実行してください。

node scripts/package.mjs firefox
node verify-firefox-build.mjs

dist/OshaberiNote-0.1.1-firefox/ に実行用ファイルを生成します。提出本体の全29ファイルとの一致を、一覧とSHA-256で検証できます。ビルドはManifest生成とコピーだけで、圧縮・難読化・トランスパイルはありません。追加のnpm依存、ネットワーク通信、APIキー、Ollamaはビルドに不要です。Ollamaはチャット利用時に別途必要です。

検証環境はWindows x64、Node.js 24.18.0です。Ubuntuでの実行そのものは未確認です。ソースZIPのビルドにはNode.js標準APIだけを使用します。
```
