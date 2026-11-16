# お気に入り8グループ（0.1.2）

## 表示と操作

設定「お気に入りグループの表示」を単一選択で追加する。`favoriteGroupDisplay` は `normal`（通常・1段4グループ、初期値）／`double`（2段8グループ）。ひきこもりnoteの製品固有modeとは分離し、おしゃべりnoteの既存動作モードは変更しない。

選択欄はテーマ設定と同じ全幅（最大520px）・余白・枠線・角丸・文字サイズを使用する。専用ホームのタイトル下・フッターの版表示はmanifestと同じ0.1.2とする。

公式ページのお気に入り登録先selectと各optionには、noteの `--color-surface-normal` と `--color-text-primary` を使って背景色・文字色を明示する。変数がない場合はCanvas／CanvasTextで対にする。Chromeで明るい文字と白いネイティブ選択肢背景が組み合わさることを避ける。記事・作者・マガジン・メンバーシップで共通の登録フォームに適用し、公式ページ全体のselectは変更しない。

左サイドバーは4列、ハンバーガー内は8グループ時に8列1行。親コンポーネントのCSSで区別し、幅のみで判定しない。狭幅では間隔・paddingを調整し、320px幅で8個を収める。従来の開閉・フォーカス・登録対象5種は維持する。

通常はgroup1〜4、2段はgroup1〜8が操作可能。専用ホーム、登録フォーム、AI回答のタグ登録、移動先に共通の操作可能グループを使う。バックグラウンドでも最新設定に対して操作元・移動先を検証し、古い画面からの非表示グループ操作を拒否する。項目の並べ替えは操作可能グループ内に限定する。グループIDの順序は固定し、グループ単位の並べ替え機能は新設しない。

⑤〜⑧の選択中に通常へ戻すとgroup1へ切り替え、選択更新番号を進める。後半のデータ・項目順は削除しない。記事のお気に入りの重複判定は非表示グループも含む全体を対象とする。タグ提案への登録済みタグ参考データも、表示設定に関係なく保存された全グループから取得する。

## 内部保存と移行

保存キー `oshaberiNote.settings.v2` と各グループの `{id,name,tags}` を維持する。新規・従来4グループは初期表示を変更せず、初めて2段を保存するとIDで不足分を空のname/tagsとして補い、`tagSchemaVersion:7` で8グループを保存する。旧2〜6は従来どおり読み込む。8グループを一度保存した後は通常へ戻しても8個を保持する。読み込みだけでストレージは書き換えない。破損データは警告と編集停止を維持し、通常設定保存による上書きを避ける。

## 共通JSON契約

外部JSONは `settings.tagGroups` の `{id,name,items}` を維持する。IDはgroup1〜group8、書き出しはID順、nameは空文字可・40文字以内。itemsは従来のtag/user/magazine/membership/articleで、各項目の検証・URL正規化・全グループ横断の記事重複防止は維持する。

おしゃべりnoteの外枠は既存の `format: "oshaberi-note-settings"`、`schemaVersion:1` を維持する。ひきこもりnoteの8グループJSON（schemaVersion:9）も取り込める。グループ構造の共通性は製品固有の表示設定や外枠の版と分離する。

```json
{
  "format": "oshaberi-note-settings",
  "schemaVersion": 1,
  "settings": {
    "favoriteGroupDisplay": "double",
    "tagGroups": [
      {"id":"group1","name":"","items":[{"type":"tag","tag":"サンプル"}]},
      {"id":"group2","name":"","items":[]},
      {"id":"group3","name":"","items":[]},
      {"id":"group4","name":"","items":[]},
      {"id":"group5","name":"作品","items":[]},
      {"id":"group6","name":"","items":[]},
      {"id":"group7","name":"","items":[]},
      {"id":"group8","name":"","items":[]}
    ],
    "selectedTagGroupId":"group5"
  }
}
```

上例は部分入力用。実際の書き出しは既存の設定項目も含む。通常表示でも保存済み8グループすべてを書き出す。4グループJSONを既存8グループへ取り込む際は⑤〜⑧を保持する。グループはIDで対応付け、入力順は問わない。重複ID・不正項目は従来の検証方針に従い読み込みを拒否する。省略グループは維持し、`items:[]` は明示的クリアとする。

表示設定が省略されていれば現在値を維持する。ひきこもりnoteの `mode:normal-double`／`normal` は、明示的なfavoriteGroupDisplayがなければdouble／normalとして取り込む。social/severeは表示設定へ転用しない。通常表示への読み込みで選択が⑤〜⑧になる場合はgroup1へ補正する。既存の形式検証・1Mi文字上限・LLM設定の製品間分離は維持する。

itemsの各種サンプル（全グループで同じ形式）：

```json
[
  {"type":"tag","tag":"サンプル"},
  {"type":"user","userId":"sample_author","displayName":"作者"},
  {"type":"magazine","userId":"sample_author","magazineId":"m123","displayName":"マガジン"},
  {"type":"membership","userId":"sample_author","displayName":"メンバーシップ"},
  {"type":"article","articleId":"n123","url":"https://note.com/sample_author/n/n123","title":"記事タイトル"}
]
```

## 検証・範囲

移行の反復、非表示データ保持、全登録対象、選択補正、古い画面からの操作拒否、JSON往復／旧JSON読み込み、管理画面・登録フォーム・タグダイアログ、左4列／メニュー8列を検証する。ブラウザ再起動相当の保存再読込も確認する。実機のクリック・タップ・note上の表示は利用者の最終確認事項とする。

ひきこもりnoteは参照のみ。今回の変更と無関係な既存未コミット変更を保持する。バージョン0.1.2を維持し、コミット・push・タグ・公開は行わない。
