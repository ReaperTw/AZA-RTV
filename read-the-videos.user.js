// ==UserScript==
// @name         Read The Videos - YouTube to Gemini
// @namespace    https://github.com/ReaperTw/AZA-RTV
// @author       AzazelTw_
// @version      0.5.9
// @description  Semi-automatic YouTube triage and Obsidian note prompts for Gemini. Sending is always manual.
// @match        https://www.youtube.com/*
// @match        https://gemini.google.com/*
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @updateURL    https://raw.githubusercontent.com/ReaperTw/AZA-RTV/main/read-the-videos.user.js
// @downloadURL  https://raw.githubusercontent.com/ReaperTw/AZA-RTV/main/read-the-videos.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const GEMINI_URL = 'https://gemini.google.com/u/2/app?hl=zh-TW';
  const JOB_KEY = 'rtv-current-job';
  const STYLE_ID = 'rtv-style';
  const AUTO_INSERT_ATTEMPTS = 60;
  const AUTO_INSERT_INTERVAL_MS = 500;
  let autoInsertStarted = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isValidJob(job) {
    return Boolean(
      job
      && typeof job.url === 'string'
      && job.url.startsWith('https://www.youtube.com/watch?')
      && typeof job.title === 'string'
      && job.title.trim()
    );
  }

  function encodeJob(job) {
    const bytes = new TextEncoder().encode(JSON.stringify(job));
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeJob(value) {
    try {
      const unpadded = value.replace(/-/g, '+').replace(/_/g, '/');
      const base64 = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const job = JSON.parse(new TextDecoder().decode(bytes));
      return isValidJob(job) ? job : null;
    } catch (_) {
      return null;
    }
  }

  function loadCurrentJob(consumeHash = false) {
    const encoded = new URLSearchParams(location.hash.slice(1)).get('rtv');
    const fromUrl = encoded ? decodeJob(encoded) : null;
    if (fromUrl) {
      try {
        sessionStorage.setItem(JOB_KEY, JSON.stringify(fromUrl));
      } catch (_) {
        // 儲存區不可用時，本頁仍使用網址任務；重新整理後需從 YouTube 重開。
      }
      if (consumeHash) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
      return { job: fromUrl, source: '網址' };
    }
    try {
      const stored = JSON.parse(sessionStorage.getItem(JOB_KEY) || 'null');
      return { job: isValidJob(stored) ? stored : null, source: '本分頁暫存' };
    } catch (_) {
      return { job: null, source: '本分頁暫存不可用' };
    }
  }

  async function copyText(text) {
    GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' });
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // GM_setClipboard 是主要方法；Clipboard API 只在瀏覽器允許時備援。
    }
  }

  function localDate(isoDate) {
    const date = isoDate ? new Date(isoDate) : new Date();
    if (Number.isNaN(date.getTime())) return new Date().toLocaleDateString('en-CA');
    return date.toLocaleDateString('en-CA');
  }

  function yamlValue(value) {
    return JSON.stringify(String(value ?? ''));
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .rtv-button {
        box-sizing: border-box; border: 0; border-radius: 20px; padding: 0 16px;
        cursor: pointer; background: #3157d5; color: white; font: 600 14px/1.2 system-ui;
        display: inline-flex; align-items: center; justify-content: center; white-space: nowrap;
      }
      .rtv-button:hover { filter: brightness(1.1); }
      .rtv-button:disabled { cursor: wait; opacity: .7; }
      #rtv-youtube-button {
        margin: 0 8px 0 0; height: 40px; min-width: max-content;
        flex: 0 0 auto; align-self: center;
      }
    `;
    document.head.appendChild(style);
  }

  function cleanYouTubeUrl() {
    const url = new URL(location.href);
    const id = url.searchParams.get('v');
    return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : location.href;
  }

  const TIMELINESS_OPTIONS = `長期有效／短期有效／已過時／無法判定`;

  const VALUE_FILTER = `留機制（條件、步驟、阻力解法、下一步）；口號留一句；無方法的鼓舞（空泛雞湯）不寫。認知重塑（舊認知→新框架→論證、案例、反例、邊界）算機制。`;

  const GROUNDING = `依據字幕。事實、主張、留言分開寫。時間戳與數據只寫字幕裡有的。產品以字幕可觀察為準。「最新」寫成講者主張。`;

  const NOTE_GROUNDING = `${GROUNDING} 公式用 $...$ 或 $$...$$，留分子、分母與條件。譯名用公認繁中，沒有公認譯名就留英文。引言歸屬不明寫「影片引用」。`;

  const HEADING = `主章節是二級標題：方括號內只放字幕上的時間，後面寫該段真正的主題。不寫「時間戳」「該段主題」。細節才用 ###。`;

  const WIKILINK = `專有名詞首次 [[公認繁中]]；沒有公認譯名就 [[English]]。普通詞不連結。`;

  const CALLOUTS = `定義用 > [!abstract]，關鍵判斷用 > [!important]，陷阱用 > [!warning]，每行以「> 」開頭；沒有該類內容不加。文字無法承載的畫面用 > [!note] 畫面參考：後面抄字幕時間。`;

  const ENVELOPE = `交付物只有一個 plaintext code block，回答從這個 code block 開始。區塊裡是要貼進 Obsidian 的 Markdown。`;

  const VAULT_NOTE = `這篇會原樣貼進 Obsidian。貼完不再有這段對話，不開影片也要能用。筆記裡不寫「如前所述」「本對話」「前一階段」。`;

  const CONTINUE_LINE = `未完則在區塊末行寫「【未完待續：章節時間＝…；最後已完成內容＝…；接續位置＝…】」，填入目前章節的字幕時間、最後完成的一句或要點，以及章內尚未完成的部分；若該章已完成，接續位置寫下一章。`;

  const TIMELINESS = `timeliness 用前一階段第 4 點；沒有就依字幕判：${TIMELINESS_OPTIONS}。寫進 YAML 的是四選一，不是這句說明。`;

  const TRANSCRIPT_REQUIRED = `完整字幕是必要前提，不是只憑網址或標題推定已讀。若字幕只有部分、無法取得，或無法確認涵蓋片頭到片尾，停止產生或續寫課堂筆記，只回報已取得範圍、缺漏與需要使用者補上的字幕。不得用常識、標題或推測補齊。此停止規則優先於下方的筆記格式與 code block 要求。`;

  function transcriptContract(job) {
    return `先確認本對話已有這支影片的完整字幕（${job.url}／${job.title}），不得沿用其他影片的字幕。繁中。${TRANSCRIPT_REQUIRED}`;
  }

  function analysisPrompt(job) {
    return `分流這支影片：
${job.url}
標題：${job.title}

讀完整字幕，片頭到片尾。繁中，只交下面 10 項，用來決定要不要存進 Obsidian：
字幕不完整或無法確認全片涵蓋時，只填可查證的內容，未知項寫無法判定；第 9 項改寫「暫停：需補完整字幕」，不得建議直接深入整理。
1. 字幕：完整／部分／無法取得
2. 涵蓋起訖；無法取得就寫無法取得
3. 一句主旨
4. 時效：${TIMELINESS_OPTIONS} + 理由
5. 具體新知、證據、案例或可執行方法；沒有就寫無
6. 性質：知識傳遞／認知重塑／空泛雞湯／宣傳／混合 + 一句依據
7. 文字無法承載、必須回看畫面的時間點；沒有就寫無
8. 留言區勘誤或補充（未驗證）；讀不到就寫無法取得
9. 建議：淘汰／深入整理
10. 理由，最多三點

${VALUE_FILTER}
${GROUNDING}`;
  }

  function detailedNotePrompt(job) {
    return `課堂紀錄。${transcriptContract(job)}
${VAULT_NOTE}
依講者順序留下解釋、推理、案例、比喻、步驟與結論。有實質的字幕段全覆蓋。筆記用技術書面繁中。口頭禪不入筆記。工商、寒暄、片頭片尾不寫。賣課只留脫離課程仍成立的知識。
${TIMELINESS}

區塊內容，順序固定：
1. YAML：第一字元 ---，結尾另起一行 ---
   - title: ${yamlValue(job.title)}
   - source: ${yamlValue(job.url)}
   - created: ${yamlValue(localDate(job.createdAt))}
   - content_type: "video_notes"
   - timeliness: "<${TIMELINESS_OPTIONS}>"
2. # ${job.title}
3. ## TL;DR：3–5 點，含主旨、最重要知識、時效、實際價值
4. ## 課堂內容（影片原序）
   ${HEADING} ${WIKILINK}
5. ## 結論與可執行項目

留言只寫「留言區補充（未驗證）」。
${CONTINUE_LINE}
${CALLOUTS}
${NOTE_GROUNDING}
${ENVELOPE}`;
  }

  function continueNotePrompt(job) {
    return `繼續同一份課堂紀錄。${transcriptContract(job)}
接在上一份筆記後面，先補完最後一個未完成的句子、清單、程式碼或章節，再繼續後面的章節；不要因為章節時間已出現就跳過該章剩餘內容，也不要重複已完成段落。
依上一則「【未完待續」的章節時間、最後已完成內容與接續位置定位。若是舊版只有時間的標記，或沒有標記，就對照上一則最後實際寫到的內容與字幕，從中斷處接續，不直接跳到下一章。無法定位就先請使用者補上上一份筆記末段，不猜測。格式、用語與字幕依據沿用上一則。
到片尾才寫 ## 結論與可執行項目。
若上一則已到片尾、只是沒進 code block，把完整筆記原樣包進區塊。
${CONTINUE_LINE}
${ENVELOPE}`;
  }

  function createYouTubeButton() {
    if (!location.pathname.startsWith('/watch')) return;

    const isVisible = (element) => (
      element.isConnected
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden'
    );
    // 播放清單版面可能不在 ytd-watch-metadata 內，但真正的操作列仍使用此 ID。
    const buttonRows = [...document.querySelectorAll('#top-level-buttons-computed')];
    const target = buttonRows.find(isVisible)
      || [...document.querySelectorAll('#actions-inner')].find(isVisible);
    if (!target) return;

    const existing = document.getElementById('rtv-youtube-button');
    if (existing) {
      // 播放清單或 SPA 導航可能重建操作列；將既有按鈕搬到目前可見的容器。
      if (existing.parentElement !== target) target.prepend(existing);
      return;
    }

    const button = document.createElement('button');
    button.id = 'rtv-youtube-button';
    button.className = 'rtv-button';
    button.type = 'button';
    button.textContent = '用 Gemini 分析';
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.title = '';
      try {
        const job = {
          url: cleanYouTubeUrl(),
          title: document.querySelector('h1 yt-formatted-string')?.textContent?.trim()
            || document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, ''),
          createdAt: new Date().toISOString()
        };
        const prompt = analysisPrompt(job);
        await copyText(prompt);
        GM_openInTab(`${GEMINI_URL}#rtv=${encodeJob(job)}`, { active: true, insert: true });
        button.textContent = 'Prompt 已複製';
      } catch (error) {
        button.textContent = '操作失敗，請重試';
        button.title = error.message || String(error);
      } finally {
        setTimeout(() => {
          button.disabled = false;
          button.textContent = '用 Gemini 分析';
        }, 1500);
      }
    });
    target.prepend(button);
  }

  function findComposer() {
    const selectors = [
      'div.ql-editor.new-input-ui[contenteditable="true"][role="textbox"]',
      'div.ql-editor[contenteditable="true"][role="textbox"]',
      'rich-textarea [contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[placeholder]',
      'textarea'
    ];
    for (const selector of selectors) {
      const editor = [...document.querySelectorAll(selector)].find((element) => {
        if (element.classList.contains('ql-clipboard') || element.closest('#rtv-panel')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (editor) return editor;
    }
    return null;
  }

  function composerText(editor) {
    return (editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || editor.textContent || '').trim();
  }

  function normalizeLines(s) {
    return String(s || '').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').trim();
  }

  function insertPrompt(text) {
    const editor = findComposer();
    if (!editor) throw new Error('找不到 Gemini 輸入框');
    if (composerText(editor)) throw new Error('輸入框已有內容；請先送出或清空（Prompt 已複製）');

    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(editor, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      document.execCommand('insertText', false, text);
    }

    const inserted = composerText(editor);
    if (normalizeLines(inserted) !== normalizeLines(text)) throw new Error('瀏覽器拒絕自動輸入；Prompt 已複製，請按 Ctrl+V');
  }

  function createElement(tag, text, styles = {}) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    Object.assign(element.style, styles);
    return element;
  }

  function createGeminiPanel() {
    if (document.getElementById('rtv-panel')) return;

    const panel = createElement('aside');
    panel.id = 'rtv-panel';
    Object.assign(panel.style, {
      position: 'fixed', right: 'clamp(12px, calc(100vw - 290px), 100px)', bottom: '30px', zIndex: '2147483647',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px',
      width: 'auto', maxWidth: 'calc(100vw - 24px)', height: 'auto', padding: '0', background: 'transparent',
      color: '#fff', fontFamily: 'system-ui, sans-serif'
    });

    const fab = createElement('button', 'RTV', {
      width: '48px', height: '48px', borderRadius: '50%', border: '1px solid #5f6368',
      background: '#1a73e8', color: '#fff', cursor: 'pointer', fontWeight: '800',
      boxShadow: '0 5px 14px rgba(0,0,0,.35)'
    });
    fab.type = 'button';
    fab.title = '開啟 Read The Videos';
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 'rtv-menu');

    const menu = createElement('div');
    menu.id = 'rtv-menu';
    Object.assign(menu.style, {
      display: 'none', flexDirection: 'column', alignItems: 'stretch', gap: '8px',
      boxSizing: 'border-box', width: '278px', maxWidth: '100%', maxHeight: '70vh', overflowY: 'auto', padding: '14px',
      borderRadius: '14px', background: 'rgba(32, 33, 36, .97)',
      boxShadow: '0 8px 24px rgba(0,0,0,.45)'
    });

    const heading = createElement('strong', 'Read The Videos', { fontSize: '15px' });
    const jobTitle = createElement('small', '尚未載入影片', {
      opacity: '.78', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    });
    jobTitle.id = 'rtv-job-title';
    const contextNotice = createElement('small', '深入整理與續寫前，會請你確認本對話已有這支影片的完整字幕。', {
      fontSize: '12px', lineHeight: '1.4', color: '#bfdbfe'
    });

    const actions = [
      ['analysis', '① 貼上字幕審查指令'],
      ['detailed', '② 貼上深入筆記指令'],
      ['continue', '③ 貼上續寫指令']
    ];
    const buttons = actions.map(([action, label], index) => {
      const button = createElement('button', label, {
        padding: '10px 12px', color: '#fff', border: 'none', borderRadius: '20px',
        cursor: 'pointer', fontWeight: '700', fontSize: '13px',
        background: index === 1 ? '#1a73e8' : '#5f6368'
      });
      button.type = 'button';
      button.dataset.action = action;
      return button;
    });

    const statusNode = createElement('div', '請自行檢查內容並手動送出', {
      marginTop: '3px', fontSize: '12px', color: '#bfdbfe', lineHeight: '1.4'
    });
    statusNode.id = 'rtv-status';

    menu.append(heading, jobTitle, contextNotice, ...buttons, statusNode);
    panel.append(menu, fab);
    document.body.appendChild(panel);

    let menuOpen = false;
    let openedByKeyboard = false;
    const setMenuOpen = (open) => {
      menuOpen = open;
      menu.style.display = open ? 'flex' : 'none';
      fab.textContent = open ? '×' : 'RTV';
      fab.title = open ? '收合 Read The Videos' : '開啟 Read The Videos';
      fab.setAttribute('aria-expanded', String(open));
    };
    fab.addEventListener('mousedown', () => { openedByKeyboard = false; });
    fab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openedByKeyboard = true; });
    fab.addEventListener('click', () => {
      const wasOpen = menuOpen;
      setMenuOpen(!menuOpen);
      if (!wasOpen && openedByKeyboard) { buttons[0]?.focus(); openedByKeyboard = false; }
    });
    const loaded = loadCurrentJob(true);
    const job = loaded.job;
    jobTitle.textContent = job?.title || '找不到 YouTube 工作項目';
    jobTitle.title = `資料來源：${loaded.source}`;

    const setStatus = (message, error = false) => {
      statusNode.textContent = message;
      statusNode.style.color = error ? '#fca5a5' : '#bfdbfe';
      fab.style.background = error ? '#b3261e' : '#1a73e8';
      fab.title = message;
    };

    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try {
        if (!job) throw new Error('請先從 YouTube 為此分頁建立工作項目');
        const conversationPath = location.pathname;
        if (button.dataset.action !== 'analysis' && !window.confirm(
          `目前影片：${job.title}\n${job.url}\n\n請確認：你已在「目前這個對話」完成這支影片的字幕審查，結果為完整且涵蓋全片。\n\n若尚未審查、字幕不完整，或已切換到其他對話，請取消，先執行字幕審查或補齊字幕。\n\n確定繼續？`
        )) return;
        const prompts = {
          analysis: analysisPrompt,
          detailed: detailedNotePrompt,
          continue: continueNotePrompt
        };
        const prompt = prompts[button.dataset.action](job);
        await copyText(prompt);
        if (location.pathname !== conversationPath) throw new Error('對話已切換，未貼上；請在目前對話重新確認字幕');
        insertPrompt(prompt);
        setStatus('已貼上；請檢查後手動送出');
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        button.disabled = false;
      }
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuOpen) { setMenuOpen(false); fab.focus(); }
    });

    // 只在從 YouTube 新開的 Gemini 頁面自動填入第一段；永遠不會自動送出。
    if (job && loaded.source === '網址' && !autoInsertStarted) {
      autoInsertStarted = true;
      (async () => {
        const prompt = analysisPrompt(job);
        const conversationPath = location.pathname;
        await copyText(prompt);
        for (let attempt = 0; attempt < AUTO_INSERT_ATTEMPTS; attempt += 1) {
          await sleep(AUTO_INSERT_INTERVAL_MS);
          if (location.pathname !== conversationPath) {
            setStatus('對話已切換，已停止自動填入；請在需要的對話重新貼上字幕審查');
            return;
          }
          const editor = findComposer();
          if (!editor) continue;
          if (composerText(editor)) {
            setStatus('輸入框已有內容，未自動覆蓋');
            return;
          }
          try {
            insertPrompt(prompt);
            setStatus('已自動填入字幕審查；請手動送出');
            return;
          } catch (_) {
            // Gemini 可能仍在建立編輯器，繼續嘗試。
          }
        }
        setStatus('無法自動填入；Prompt 已複製，請按 Ctrl+V', true);
      })();
    }
  }

  addStyles();
  if (location.hostname === 'www.youtube.com') {
    createYouTubeButton();
    new MutationObserver(createYouTubeButton)
      .observe(document.documentElement, { childList: true, subtree: true });
  } else if (location.hostname === 'gemini.google.com') {
    createGeminiPanel();
    // Gemini 是 SPA，切換對話時可能重建 DOM。
    new MutationObserver(() => {
      if (!document.getElementById('rtv-panel')) createGeminiPanel();
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
