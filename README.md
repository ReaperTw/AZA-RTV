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
3. 先確認字幕審查為「完整」且涵蓋全片，再根據「淘汰／深入整理」做人工決定。字幕不完整或無法取得時，先補齊字幕，不直接產生深入筆記。
4. 在同一個 Gemini 對話展開 `RTV`，選擇「產生深入課堂紀錄」。確認視窗會顯示影片標題與網址；確認目前對話確實已有這支影片的完整字幕後才繼續，再手動送出。
5. Gemini 會把完整 Markdown 包在 `plaintext` code block；用右上角 Copy 一次複製後貼進 Obsidian。也可用原有的 Gemini Exporter。
6. 未完成時，點「繼續未完成筆記」並再次確認對話。續寫會要求先補完中斷的句子或章節，再往後寫；無法定位時會要求提供上一份筆記末段。

## 重要行為

- 分析結果不會被重新貼回 Gemini；後續 Prompt 直接沿用同一對話的字幕資料。
- 影片任務保存在各 Gemini 分頁的 `sessionStorage`；同一分頁重新整理仍保留，開啟其他影片不會改掉既有分頁的任務。沒有任務的分頁需從 YouTube 按鈕重新開啟，不再取用全域最後一支影片。更新前已開啟的舊 Gemini 分頁也需重新從 YouTube 開啟。
- 深入整理與續寫每次都會要求人工確認，目前沒有自動驗證字幕或辨識對話內容；切換到其他對話後，必須先完成該影片的字幕審查。複製期間切換對話時不會繼續貼上，自動填入等待期間切換對話也會停止。
- Prompt 要求字幕不完整時暫停整理、回報缺漏，不得猜測補齊；這是給模型的規則，不是完整字幕的技術保證，仍須人工檢查回覆。
- 輸入框已有文字時，RTV 不會覆蓋或追加，但 Prompt 仍會放在剪貼簿供手動貼上。
- RTV 預設放在右下角、Gemini Exporter 按鈕左側；窄螢幕會調整右距及面板寬度，保留左右至少 12px 的空間。
- YouTube 按鈕遇到複製或開啟分頁錯誤時，會顯示「操作失敗，請重試」，滑鼠提示保留錯誤原因；1.5 秒後恢復可點，不會自動重試。
- RTV 操作使用原生按鈕：Tab／Shift+Tab 切換焦點，Enter／空白鍵啟動；不使用方向鍵選單操作。
- Gemini 或 YouTube 改版後，可能需要更新輸入框或按鈕的 DOM 選擇器。

## 開發驗證

執行 `node --test tests/userscript.test.cjs`，涵蓋分頁任務隔離、重新整理保留任務、逐次對話確認、切換對話停止填入、既有草稿保護，以及 YouTube 複製／開啟失敗後可重新操作。測試使用模擬 DOM 與瀏覽器介面，不連線 Gemini，也不驗證模型是否遵守 Prompt。
新增 browser smoke（真實 Chromium、page request interception HTML fixture、注入真實 source 為 script、GM_setClipboard/navigator clipboard mock、native execCommand full insert、main-world override 模擬 partial）：驗證鍵盤開啟+Tab、Esc 焦點返回 RTV、滑鼠開啟不搶焦點、新標籤 ①②③、完整 vs partial 插入含換行正規化。
