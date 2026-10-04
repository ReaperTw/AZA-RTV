# Read The Videos

半自動將 YouTube 影片交給 Gemini 網頁版審查，再依人工決定是否產生 Obsidian 深入筆記。不需要 API，腳本也不會自動送出訊息。

## 安裝

1. 安裝 Tampermonkey。
2. 打開 [read-the-videos.user.js](https://raw.githubusercontent.com/ReaperTw/AZA-RTV/main/read-the-videos.user.js)，確認安裝。
3. 重新整理 YouTube 與 Gemini 頁面。

之後提高 `@version` 並推上 `main`，Tampermonkey 會偵測更新。已手動貼上的舊腳本要先改用上面的網址安裝一次，才會跟著遠端更新。

## 使用

1. 在 YouTube 影片頁點「用 Gemini 分析」。
2. 腳本會開啟 Gemini `/u/2/` 並自動填入字幕審查 Prompt；檢查後由你手動送出。
3. 根據「淘汰／深入整理」結果做人工決定。
4. 在同一個 Gemini 對話展開 `RTV`，選擇「產生深入課堂紀錄」，再手動送出。
5. Gemini 會把完整 Markdown 包在 `plaintext` code block；用右上角 Copy 一次複製後貼進 Obsidian。也可用原有的 Gemini Exporter。

## 重要行為

- 分析結果不會被重新貼回 Gemini；後續 Prompt 直接沿用同一對話的字幕資料。
- 輸入框已有文字時，RTV 不會覆蓋或追加，但 Prompt 仍會放在剪貼簿供手動貼上。
- RTV 預設放在右下角、Gemini Exporter 按鈕左側。
- Gemini 或 YouTube 改版後，可能需要更新輸入框或按鈕的 DOM 選擇器。
