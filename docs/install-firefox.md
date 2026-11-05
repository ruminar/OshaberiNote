# Firefox 試作の読み込み

PC版Firefox 140以上で、既存のひきこもりnoteを無効にしてください。`about:debugging#/runtime/this-firefox` →「一時的なアドオンを読み込む」から、このフォルダの `manifest.json` を指定します。Androidは対象外です。

Ollamaを起動し、拡張アイコン →「接続・再試行」→ 接続権限と会話送信の任意同意（personalCommunications）の許可 → モデル選択 → 送信の順で確認します。拒否しても既存のnote機能は利用できます。接続先変更時は会話を削除します。

必要な場合はOllamaの `OLLAMA_ORIGINS` にこの専用ホームの実際の `moz-extension://実行時UUID` を追加して再起動します。アドオンIDと実行時UUIDは異なります。全サイト・全拡張を許可しないでください。

ローカル専用運用ではOllama側で `OLLAMA_NO_CLOUD=1` を設定して再起動してください。HTTPのLAN通信は暗号化されません。この試作は署名・公開していません。
