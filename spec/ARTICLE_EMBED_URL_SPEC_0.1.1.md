# 記事の埋め込みURL取得（0.1.1）

2026-11-07、利用者確認済みの取得方針に基づく。

## 取得範囲

- 本文の表示可能な埋め込み枠（figureのembedded-service）を対象にする。
- 外側のdata-src・data-emb-urlを優先する。なければ、元リンクを示す外側のアンカーを調べる。
- それもなければiframe要素のdata-src・src属性を読む。未読込のvisibility:hiddenは許容するが、hidden・aria-hidden・display:none等で除外された情報は使わない。
- Iframelyの元リンクを示すアンカーや外部カードのタイトルリンクを優先し、キャプションや、iframeに付随するサービスのトップページを元URLとして選ばない。
- HTTP(S)のみ。ユーザー名・パスワード付きURL、javascript/data/about/blob、srcdoc本文は使わない。
- 属性を書き換えない。スクロール・表示範囲の移動・イベント偽装・追加通信での読み込みは行わない。

## 表示

```text
[リンクカード]
URL：https://example.com/content
```

通常URLへ確定できない場合：

```text
[リンクカード]
埋め込みURL：https://example.com/player/123
```

どちらも確認できない場合は「URL：（未取得）」とする。複数の表示用URLがある場合は推測で一つにせず、重複を除いて列挙する。

既存のnote記事・外部記事・クリエーターページ・添付・GitHubの整形は維持する。URL補完によって、以前から取得できていた投稿文・説明・キャプションを削除しない。通常の空アンカーや画像リンクの取得方針は変更しない。

## 確定的に変換する形式

- YouTube／YouTube nocookieの単一動画 `/embed/VIDEO_ID` → watch URL。確認できるlist・開始秒・フラグメントを保持する。videoseries・live_streamは単一動画へ変換しない。
- Spotifyの既知の `/embed/{種別}/{22文字ID}` → 同じ種別・IDの通常URL。
- CodePenの既知の `/{利用者}/embed/[preview/]{ID}` → `/{利用者}/pen/{ID}`。
- ホスト名を完全一致で確認する。似たドメインや未知の構造は変換しない。
- その他のサービスは推測せず、表示用URLとして残す。

参考：[YouTube](https://developers.google.com/youtube/player_parameters)、[Spotify](https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed)、[CodePen](https://blog.codepen.io/documentation/embedded-pens/)。

## 既存処理との境界

今回のURL補完ではcontentDocument・contentWindowを使わない。従来から対応している、外側の元URLと一致する読み込み済み同一オリジンnoteカードのタイトル・著者取得は維持する。旧形式のURLを補完するためにこの内部読み取りを拡大しない。

本文の共通抽出処理で整形するため、コピー・記事Map保存・LLM送信へ同じ情報が反映される。既存の保存済み記事を自動修正せず、再取り込みで反映する。LLMには通常URLと埋め込みURLを区別し、未取得URLを推測しないよう指示する。
