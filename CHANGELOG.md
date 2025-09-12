# Changelog

## v0.1.0

- translate: 既定動作を「Google翻訳を新規タブで開く」に統一
- feature: `ENABLE_INLINE_TRANSLATION` で上部バブル（インライン翻訳）を温存（既定OFF）
- fix: hostileなサイト対策で `el.style`/`setAttribute('style')` に触れない設計へ
- fix: Shadow DOM 内の動的 `<style>` で表示/位置を制御し、TypeError を解消
- style: 最小CSSを動的 `<style>` に同梱し、`content.css` 不達でもカプセル見た目を保証
- docs: READMEを現状仕様に更新（上部バブルの記述を削除、ユーザー向け手順を追加）
- chore: アイコン（16/48/128）を追加し manifest に反映
- build: 配布用 zip（quick-select-tools-0.1.0.zip）作成手順を整理

