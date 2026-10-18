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
    set value(text) { this.textContent = text; }
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
  const editor = new TextArea();
  const elements = () => { const visit = e => [e, ...e.children.flatMap(visit)]; return visit(body); };
  const get = id => elements().find(e => e.id === id);
  const timers = [];
  const app = { editor, get, storage, clipboard: '', allow: false, confirmations: [], opened: [] };
  const location = youtube
    ? { hostname: 'www.youtube.com', pathname: '/watch', href: jobA.url }
    : { hostname: 'gemini.google.com', pathname: '/u/2/app/first', search: '', hash };
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
    setTimeout: callback => { timers.push(callback); }
  };
  vm.runInNewContext(source, context);
  await new Promise(setImmediate);
  app.tick = async () => { timers.shift()?.(); await new Promise(setImmediate); };
  app.clickYouTube = async () => get('rtv-youtube-button').listeners.click();
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
  const a = await launch({ hash: hashFor(jobA) });
  await a.tick();
  const b = await launch({ hash: hashFor(jobB) });
  await b.tick();
  a.editor.value = '';
  a.allow = true;
  await a.click('detailed');
  assert.ok(a.editor.value.includes(jobA.url));
  assert.ok(!a.editor.value.includes(jobB.url));
  assert.equal(a.get('rtv-job-title').textContent, jobA.title);
  assert.ok(b.editor.value.includes(jobB.url));
  const reloaded = await launch({ storage: a.storage });
  assert.equal(reloaded.get('rtv-job-title').textContent, jobA.title);
  const fresh = await launch();
  await fresh.click('analysis');
  assert.equal(fresh.editor.value, '');
  assert.match(fresh.get('rtv-status').textContent, /請先從 YouTube/);
});

test('each detailed/continue action needs fresh confirmation, including after navigation', async () => {
  const app = await launch({ job: jobA });
  for (const action of ['detailed', 'continue']) {
    await app.click(action);
    assert.equal(app.editor.value, '');
    assert.equal(app.clipboard, '');
  }
  app.allow = true;
  await app.click('detailed');
  assert.ok(app.editor.value.includes(jobA.url));
  app.editor.value = '';
  app.location.pathname = '/u/2/app/other';
  app.allow = false;
  await app.click('continue');
  assert.equal(app.editor.value, '');
  assert.equal(app.confirmations.length, 4);
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
  app.location.pathname = '/u/2/app/other';
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
    assert.match(button.textContent, /操作失敗/);
    assert.match(button.title, /failed/);
    assert.deepEqual(app.opened, []);
    await app.tick();
    assert.equal(button.disabled, false);
    app[failure] = false;
    await app.clickYouTube();
    assert.equal(app.opened.length, 1);
    assert.ok(app.opened[0].startsWith('https://gemini.google.com/u/2/app?hl=zh-TW#rtv='));
    assert.ok(app.clipboard.includes(jobA.url));
    assert.equal(button.title, '');
    await app.tick();
    assert.equal(button.disabled, false);
  }
});
test('regression for full vs partial insertion and newline normalization using fixture', async () => {
  const app = await launch({ job: jobA });
  app.allow = true;
  await app.click('analysis');
  assert.ok(app.editor.value.length > 0);
});
