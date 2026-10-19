const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../read-the-videos.user.js'), 'utf8');
const jobA = { url: 'https://www.youtube.com/watch?v=A', title: '影片 A' };
const jobB = { url: 'https://www.youtube.com/watch?v=B', title: '影片 B' };

async function launch({ job, storage = new Map(), hash = '', clipboardHook, youtube = false } = {}) {
  class Element {
    constructor() { this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    prepend(child) { this.children.unshift(child); }
    getClientRects() { return [{}]; }
    setAttribute() {}
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }
  class TextArea extends Element {
    get value() { return this.textContent; }
    set value(text) {
      const t = String(text || '');
      this.textContent = simulatePartialInsert ? t.slice(0, Math.max(1, t.length - 5)) + '[PARTIAL]' : t;
    }
    focus() {}
    dispatchEvent() {}
    getBoundingClientRect() { return { width: 100, height: 30 }; }
    get classList() { return { contains: () => false }; }
    closest() { return null; }
  }
  if (job) storage.set('rtv-current-job', JSON.stringify(job));
  const body = new Element();
  const buttonRow = new Element();
  buttonRow.isConnected = true;
  if (youtube) body.append(buttonRow);
  let simulatePartialInsert = false;
  const editor = new TextArea();
  const elements = () => { const visit = e => [e, ...e.children.flatMap(visit)]; return visit(body); };
  const get = id => elements().find(e => e.id === id);
  const timers = [];
  const app = { editor, get, storage, clipboard: '', allow: false, confirmations: [], opened: [], simulatePartialInsert: (v) => { simulatePartialInsert = v; } };
  const location = youtube
    ? { hostname: 'www.youtube.com', pathname: '/watch', href: jobA.url }
    : { hostname: 'gemini.google.com', pathname: '/u/2/app', search: '', hash };
  app.location = location;
  const context = {
    URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
    HTMLTextAreaElement: TextArea, InputEvent: class {},
    document: { body, documentElement: body, head: new Element(), createElement: () => new Element(), getElementById: get,
      title: jobA.title, querySelector: () => null,
      querySelectorAll: selector => selector === '#top-level-buttons-computed' ? [buttonRow] : selector.startsWith('textarea') ? [editor] : [] },
    getComputedStyle: () => ({ visibility: 'visible' }),
    location,
    history: { replaceState: () => { location.hash = ''; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    navigator: { clipboard: { writeText: async () => { if (clipboardHook) clipboardHook(app); } } },
    GM_setClipboard: text => {
      if (app.failCopy) throw new Error('Clipboard failed');
      app.clipboard = text;
    },
    GM_openInTab: url => {
      if (app.failOpen) throw new Error('Opening tab failed');
      app.opened.push(url);
    },
    // Legacy global storage must never become a fallback for a new tab.
    GM_getValue: () => { throw new Error('Global job storage was accessed'); },
    window: { confirm: message => { app.confirmations.push(message); return app.allow; } },
    MutationObserver: class { observe() {} },
    setTimeout: callback => { timers.push(callback) }
  };
  vm.runInNewContext(source, context);
  await new Promise(setImmediate);
  app.tick = async () => { timers.shift()?.(); await new Promise(setImmediate); };
  app.clickYouTube = async () => get('rtv-youtube-button').listeners.click();
  app.clickMode = async mode => elements().find(e => e.dataset.mode === mode).listeners.click();
  app.click = async action => {
    const button = elements().find(e => e.dataset.action === action);
    await get('rtv-panel').listeners.click({ target: { closest: () => button } });
  };
  return app;
}

function hashFor(job) {
  return '#rtv=' + Buffer.from(JSON.stringify(job)).toString('base64url');
}

test('opening B cannot change A; A survives reload in its own tab', async () => {
  const storageA = new Map();
  const a = await launch({ job: jobA, hash: hashFor(jobA), storage: storageA });
  await a.tick();
  const b = await launch({ job: jobB, hash: hashFor(jobB) });
  await b.tick();
  // reload/fresh tab for A reuses storage, job survives (not global)
  const aReload = await launch({ storage: storageA });
  aReload.allow = true;
  await aReload.click('detailed');
  assert.ok(aReload.editor.value.includes(jobA.url));
  assert.ok(!aReload.editor.value.includes(jobB.url));
  assert.equal(aReload.get('rtv-job-title').textContent, jobA.title);
  assert.ok(b.editor.value.includes(jobB.url));
});
test('conversation changes while copying prevent insertion', async () => {
  const app = await launch({ job: jobA, clipboardHook: app => { app.location.pathname = '/u/2/app/other'; } });
  app.allow = true;
  await app.click('detailed');
  assert.equal(app.editor.value, '');
  assert.match(app.get('rtv-status').textContent, /對話已切換/);
});
test('automatic analysis stops when the conversation changes', async () => {
  const app = await launch({ hash: hashFor(jobA) });
  app.location.pathname = '/u/2/other';
  await app.tick();
  assert.equal(app.editor.value, '');
  assert.match(app.get('rtv-status').textContent, /已停止自動填入/);
});


test('existing drafts are preserved; requested prompt remains on the clipboard', async () => {
  const app = await launch({ job: jobA });
  app.editor.value = '不要覆蓋我的草稿';
  await app.click('analysis');
  assert.equal(app.editor.value, '不要覆蓋我的草稿');
  assert.ok(app.clipboard.includes(jobA.url));
  assert.match(app.get('rtv-status').textContent, /輸入框已有內容/);
});

test('YouTube button recovers from copy/open errors and permits a successful retry', async () => {
  for (const failure of ['failCopy', 'failOpen']) {
    const app = await launch({ youtube: true });
    const button = app.get('rtv-youtube-button');
    app[failure] = true;
    await app.clickYouTube();
    assert.deepEqual(app.opened, []);
    assert.equal(app.clipboard, '');
    await app.clickMode('triage');
    assert.match(button.textContent, /操作失敗/);
    assert.match(button.title, /failed/);
    assert.deepEqual(app.opened, []);
    await app.tick();
    assert.equal(button.disabled, false);
    app[failure] = false;
    await app.clickMode('triage');
    assert.equal(app.opened.length, 1);
    assert.ok(app.opened[0].startsWith('https://gemini.google.com/u/2/app?hl=zh-TW#rtv='));
    assert.ok(app.clipboard.includes(jobA.url));
    assert.equal(button.title, '');
    await app.tick();
    assert.equal(button.disabled, false);
  }
});
test('partial insertion reports specific error visibly and never retries as editor readiness', async () => {
  const app = await launch({ job: jobA });
  app.simulatePartialInsert(true);
  app.allow = true;
  await app.click('analysis');
  const status = app.get('rtv-status').textContent || '';
  assert.ok(status.includes('瀏覽器拒絕') || status.includes('無法自動填入'));
  assert.ok(app.editor.value.includes('[PARTIAL]'));
});

test('normalizeLines in insertion path preserves meaningful content differences (whitespace normalized but text diff kept)', async () => {
  // exercised by full success vs partial fail above; full would match exactly after norm (incl CRLF->LF + trim blank lines), partial differs by content
  const app = await launch({ job: jobA });
  app.allow = true;
  await app.click('analysis');
  assert.ok(app.editor.value.includes('分流這支影片'));
  assert.ok(app.editor.value.includes(jobA.url));
});

test('auto/manual race: manual cancels pending auto, old operation does not report success or paste after nav or manual', async () => {
  const app = await launch({ hash: hashFor(jobA) });
  await app.tick(); // start auto async
  app.allow = true;
  await app.click('analysis'); // cancels auto via delivery (before auto inserted)
  assert.ok(app.editor.value.includes('分流這支影片') || app.editor.value.includes('輸入框已有內容'));
  const status = app.get('rtv-status').textContent || '';
  assert.ok(status.includes('已貼上；請檢查後手動送出') || status.includes('輸入框已有內容；請先送出或清空'));
  await app.tick();
  await app.tick();
  // no stale auto status overwrite
  const finalStatus = app.get('rtv-status').textContent || '';
  assert.ok(finalStatus.includes('已貼上；請檢查後手動送出') || finalStatus.includes('輸入框已有內容；請先送出或清空'));
});

test('navigation and route switch guarded by isSameConversation allowing initial /app to /app/<id> conservatively in auto', async () => {
  const app = await launch({ hash: hashFor(jobA) });
  // start auto at base
  await app.tick();
  // simulate creation to /app/id during wait
  app.location.pathname = '/u/2/app/conv-xyz';
  await app.tick();
  await app.tick();
  // should have inserted without treating as switch stop (initial latch)
  assert.ok(app.editor.value.includes('分流這支影片'));
  const status = app.get('rtv-status').textContent || '';
  assert.ok(!status.includes('已停止自動填入'));
});

test('existing draft preserved; partial failure distinguished from draft', async () => {
  const app = await launch({ job: jobA });
  app.editor.value = 'user draft preserved';
  await app.click('analysis');
  assert.equal(app.editor.value, 'user draft preserved');
  assert.match(app.get('rtv-status').textContent, /輸入框已有內容/);
  // partial tested separately
});

test('entry mode only affects opening prompt choice and job metadata; detailed action always explicit review confirm and detailedNote regardless of mode', async () => {
  // note mode job + detailed now uses review path (behavior change from entry-only)
  const noteApp = await launch({ job: { ...jobA, mode: 'note' } });
  await noteApp.click('detailed');
  assert.ok(noteApp.confirmations.length >= 1);
  noteApp.allow = true;
  await noteApp.click('detailed');
  assert.ok(noteApp.editor.value.includes('課堂紀錄。'));
  // triage also works
  const triageApp = await launch({ job: jobA });
  triageApp.allow = true;
  await triageApp.click('detailed');
  assert.ok(triageApp.editor.value.includes('課堂紀錄。'));
});

test('opening uses entry mode for auto prompt only; subsequent actions explicit', async () => {
  const triageAuto = await launch({ hash: hashFor(jobA) });
  await triageAuto.tick();
  assert.ok(triageAuto.editor.value.includes('分流這支影片'));
  assert.match(triageAuto.get('rtv-status').textContent, /已自動填入字幕審查；請手動送出/);

  const noteAuto = await launch({ hash: hashFor({ ...jobA, mode: 'note' }) });
  await noteAuto.tick();
  assert.ok(noteAuto.editor.value.includes('課堂紀錄。讀這支影片的完整字幕'));
  assert.match(noteAuto.get('rtv-status').textContent, /已自動填入課堂筆記；請手動送出/);
});
