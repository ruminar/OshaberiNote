# Firefox 0.1.0 ソース提出

Mozillaは、独自ツールなどで提出ファイルを生成する場合、対応するソースと再現手順の提出を案内しています。0.1.0はJavaScriptの圧縮・難読化は行いませんが、Firefox用Manifestの生成工程があるため、提出用ソース一式を用意しました。[Mozilla公式ソース提出案内](https://extensionworkshop.com/documentation/publish/source-code-submission/)

## アップロード欄とファイル

| 申請画面の欄 | アップロードするファイル |
| --- | --- |
| アドオン本体・Upload Version | `dist/OshaberiNote-0.1.0-firefox.zip` |
| ソースコード・Source code | `dist/OshaberiNote-0.1.0-firefox-source.zip` |

この2つを取り違えないでください。どちらもZIPのままアップロードします。ソース提出の質問では提出する方を選び、ソース欄へ後者を指定します。

すでにバージョンを提出している場合も、AMOの対象バージョン編集画面のSource code欄から追加できます。実際の画面で対象が0.1.0であることを確認してください。

## 対応するリリース

- タグ：`0.1.0`
- コミット：`af02ee8ea208266cdb77b09d130a44558eb5c81f`
- 本体ZIPのSHA-256：`e54ae8315e41161dcf8d248ec70bc28e8d096aa26d247240aa3ea0dd199cf436`
- ソースZIPのSHA-256：`9c4688c55e2849fa8306cc6d255e173b9463278d369297d1f5a799406cee1d14`

現在のdevelopの作業途中の書類ではなく、リリースタグの55追跡ファイルを元にしています。公開パッケージへコピーされるファイルは公開物の改行コードを保持し、別OSへZIPを展開しても同じ内容を生成できる構成です。実行コードの変更はありません。

ソースZIPには次の審査用3ファイルを加えています。

- `README_BUILDING.md`：日本語・英語の環境と再現手順。
- `firefox-payload-sha256.json`：公開済み本体の全29ファイルのSHA-256。
- `verify-firefox-build.mjs`：生成した全ファイルの一覧とハッシュを照合するスクリプト。

ソースZIPは計58ファイルで、Git管理情報・一時ファイル・利用者の設定や会話・生成済みdistは含みません。

## 審査担当者へ貼る説明

```text
ソースZIPはおしゃべりnote 0.1.0タグ（af02ee8ea208266cdb77b09d130a44558eb5c81f）に対応します。ルートのREADME_BUILDING.mdに日本語・英語の再現手順を記載しています。

Node.js 24.xを用意し、ソースZIPを展開したルートで以下を実行してください。

node scripts/package.mjs firefox
node verify-firefox-build.mjs

dist/OshaberiNote-0.1.0-firefox/ に本体を生成します。公開済みパッケージの全29ファイルとの一致を、同梱の検証スクリプトで確認できます。JavaScriptの圧縮・難読化・トランスパイルはなく、Firefox Manifestの生成とファイルのコピーだけです。追加のnpm依存・ネットワーク・APIキー・Ollamaはビルドには不要です。Ollamaはチャット実行時に別途必要です。

ビルドおよびこのソースからの検証環境はWindows x64、Node.js 24.18.0です。Node.js標準APIだけを使う構成ですが、Ubuntu上での実行そのものは未確認です。
```

## 実施した検証

- 提出用ソースZIPを別の検証用フォルダへ展開。
- 展開先のソースだけを使ってFirefox版を生成。
- 本体ZIPと再生成フォルダの全29ファイルがバイト単位で一致。
- 展開先のソースから自動試験470件成功（失敗・スキップなし）。
- 本体ZIPは変更していません。GitHub Releaseの添付物やタグも変更していません。
- Firefox／Ubuntuの実機確認およびAMOへのアップロードは未実施です。

個別の検証結果は `dist/firefox-source-verification.json` に記録しています。
