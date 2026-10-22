const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../read-the-videos.user.js'), 'utf8');
const jobA = { url: 'https://www.youtube.com/watch?v=A', title: '影片 A', createdAt: '2026-10-15T00:00:00Z' };
const jobB = { ...jobA, url: 'https://www.youtube.com/watch?v=B', title: '影片 B' };
const flush = () => new Promise(setImmediate);
const hashFor = job => '#rtv=' + Buffer.from(JSON.stringify(job)).toString('base64url');

async function launch({ job, hash = '', storage = new Map(), youtube = false,
  pathname = '/u/2/app', editorKind = 'textarea', composerReady = true,
  transform = text => text, copyHook } = {}) {
  class Element {
    constructor() {
      this.style = {}; this.dataset = {}; this.children = []; this.listeners = {};
      this.textContent = ''; this.attributes = {}; this.disabled = false;
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    prepend(child) { this.children.unshift(child); }
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { width: 400, height: 100 }; }
    get classList() { return { contains: () => false }; }
    closest() { return null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    focus() { document.activeElement = this; }
    dispatchEvent() {}
    get innerText() { return this.textContent; }
    get childNodes() { return this.textContent ? [{ nodeType: 3, nodeValue: this.textContent }] : []; }
  }
  class TextArea extends Element {
    get value() { return this.textContent; }
    set value(text) { insert(String(text)); }
  }
  const body = new Element();
  const row = new Element();
  row.isConnected = true;
  if (youtube) body.append(row);
  const editor = editorKind === 'textarea' ? new TextArea() : new Element();
  const visit = element => [element, ...element.children.flatMap(visit)];
  const get = id => visit(body).find(element => element.id === id);
  const timers = [];
  const location = youtube
    ? { hostname: 'www.youtube.com', pathname: '/watch', href: jobA.url }
    : { hostname: 'gemini.google.com', pathname, search: '', hash };
  const app = {
    editor, get, storage, location, clipboard: '', allow: false, confirmations: [], opened: [],
    insertions: [], composerReady, transform, copyHook,
    draft(text) { editor.textContent = text; },
    get text() { return editor.textContent; },
    get status() { return get('rtv-status').textContent; }
  };
  function insert(text) {
    app.insertions.push(text);
    editor.textContent = app.transform(text);
  }
  const document = {
    body, head: new Element(), documentElement: body, activeElement: null, title: jobA.title,
    createElement: () => new Element(), getElementById: get, querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '#top-level-buttons-computed') return [row];
      if (!app.composerReady) return [];
      if (editorKind === 'textarea') return selector.startsWith('textarea') ? [editor] : [];
      return selector.includes('contenteditable') ? [editor] : [];
    },
    execCommand(command, _ui, text) {
      assert.equal(command, 'insertText');
      assert.equal(document.activeElement, editor);
      insert(text);
      return true;
    }
  };
  if (job) storage.set('rtv-current-job', JSON.stringify(job));
  vm.runInNewContext(source, {
    URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
    HTMLTextAreaElement: TextArea, InputEvent: class {}, document, location,
    getComputedStyle: () => ({ visibility: 'visible' }),
    history: { replaceState: () => { location.hash = ''; } },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)
    },
    navigator: { clipboard: { writeText: async text => { if (app.copyHook) await app.copyHook(app, text); } } },
    GM_setClipboard(text) {
      if (app.failCopy) throw new Error('Clipboard failed');
      app.clipboard = text;
    },
    GM_openInTab(url) {
      if (app.failOpen) throw new Error('Opening tab failed');
      app.opened.push(url);
    },
    GM_getValue: () => { throw new Error('Legacy global storage must not be used'); },
    window: { confirm: message => { app.confirmations.push(message); return app.allow; } },
    MutationObserver: class { observe() {} },
    setTimeout: callback => { timers.push(callback); }
  });
  await flush();
  app.tick = async () => { timers.shift()?.(); await flush(); };
  app.click = async action => {
    const button = visit(body).find(element => element.dataset.action === action);
    assert.ok(button, `Missing action: ${action}`);
    await get('rtv-panel').listeners.click({ target: { closest: () => button } });
  };
  app.clickYouTube = async () => get('rtv-youtube-button').listeners.click();
  app.clickMode = async mode => {
    const button = visit(body).find(element => element.dataset.mode === mode);
    await button.listeners.click();
  };
  return app;
}

test('video jobs stay isolated across tabs and survive reload without leaking into a fresh tab', async () => {
  const storageA = new Map();
  const a = await launch({ hash: hashFor(jobA), storage: storageA });
  const b = await launch({ hash: hashFor(jobB) });
  await a.tick(); await b.tick();
  assert.ok(a.text.includes(jobA.url));
  assert.ok(!a.text.includes(jobB.url));
  assert.ok(b.text.includes(jobB.url));
  const reloaded = await launch({ storage: storageA });
  await reloaded.click('analysis');
  assert.ok(reloaded.text.includes(jobA.url));
  assert.ok(!reloaded.text.includes(jobB.url));
  const fresh = await launch();
  await assert.doesNotReject(fresh.click('analysis'));
  assert.equal(fresh.text, '');
  assert.equal(fresh.clipboard, '');
  assert.match(fresh.status, /YouTube/);
});

for (const destination of ['/u/2/app/existing-video', '/u/2/other']) {
  test(`pending auto insertion stops before writing into ${destination}`, async () => {
    const app = await launch({ hash: hashFor(jobA), composerReady: false });
    assert.equal(app.text, '');
    app.location.pathname = destination;
    app.composerReady = true;
    await app.tick();
    assert.equal(app.text, '');
    assert.deepEqual(app.insertions, []);
    assert.match(app.status, /對話已切換/);
  });
}

test('an old association cannot authorize navigation back to a different conversation', async () => {
  const storage = new Map([['rtv-conv-assoc', '/u/2/app/old']]);
  const app = await launch({ hash: hashFor(jobA), storage, pathname: '/u/2/app/new', composerReady: false });
  app.location.pathname = '/u/2/app/old';
  app.composerReady = true;
  await app.tick();
  assert.equal(app.text, '');
  assert.match(app.status, /對話已切換/);
});

test('a new hash job removes the previous conversation association before insertion', async () => {
  const storage = new Map([['rtv-conv-assoc', JSON.stringify({ url: jobA.url, path: '/u/2/app/A' })]]);
  const app = await launch({ hash: hashFor(jobB), storage });
  assert.equal(storage.has('rtv-conv-assoc'), false);
  await app.tick();
  assert.ok(app.text.includes(jobB.url));
  assert.ok(!app.text.includes(jobA.url));
});

test('changing conversations requires confirmation and only accepted insertion updates the stored association', async () => {
  const previous = { url: jobA.url, path: '/u/2/app/original' };
  const storage = new Map([['rtv-conv-assoc', JSON.stringify(previous)]]);
  const app = await launch({ job: jobA, storage, pathname: '/u/2/app/other' });
  await app.click('analysis');
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.text, '');
  assert.equal(app.clipboard, '');
  assert.deepEqual(JSON.parse(storage.get('rtv-conv-assoc')), previous);
  app.allow = true;
  await app.click('analysis');
  assert.ok(app.text.includes(jobA.url));
  assert.deepEqual(JSON.parse(storage.get('rtv-conv-assoc')), { url: jobA.url, path: '/u/2/app/other' });
  const reloaded = await launch({ storage, pathname: '/u/2/app/other' });
  await reloaded.click('analysis');
  assert.ok(reloaded.text.includes(jobA.url));
  assert.deepEqual(reloaded.confirmations, []);
});

test('the conversation association is not updated when insertion fails', async () => {
  const previous = { url: jobA.url, path: '/u/2/app/original' };
  const storage = new Map([['rtv-conv-assoc', JSON.stringify(previous)]]);
  const app = await launch({ job: jobA, storage, pathname: '/u/2/app/other', transform: text => text.slice(0, 5) });
  app.allow = true;
  await app.click('analysis');
  assert.match(app.status, /全選替換或清空/);
  assert.deepEqual(JSON.parse(storage.get('rtv-conv-assoc')), previous);
});

test('manual insertion is stopped if the conversation changes during clipboard work', async () => {
  const app = await launch({ job: jobA, copyHook: app => { app.location.pathname = '/u/2/app/other'; } });
  app.allow = true;
  await app.click('detailed');
  assert.equal(app.text, '');
  assert.deepEqual(app.insertions, []);
  assert.match(app.status, /對話已切換/);
});

test('canceling a confirmation leaves the pending automatic opening intact', async () => {
  const app = await launch({ hash: hashFor(jobA) });
  const opening = app.clipboard;
  assert.equal(app.text, '');
  await app.click('detailed');
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.text, '');
  await app.tick();
  assert.equal(app.text, opening);
  assert.equal(app.insertions.length, 1);
  assert.match(app.status, /已自動填入/);
});

test('accepted manual work wins before the automatic timer can insert or report success', async () => {
  const app = await launch({ hash: hashFor(jobA) });
  const opening = app.clipboard;
  assert.equal(app.text, '');
  app.allow = true;
  await app.click('detailed');
  const manual = app.clipboard;
  assert.notEqual(manual, opening);
  assert.equal(app.text, manual);
  assert.match(app.status, /^已貼上/);
  const status = app.status;
  await app.tick(); await app.tick();
  assert.equal(app.text, manual);
  assert.equal(app.status, status);
  assert.equal(app.insertions.length, 1);
});

test('an older asynchronous manual operation cannot overwrite a newer one', async () => {
  const app = await launch({ job: jobA });
  app.allow = true;
  let release;
  app.copyHook = () => new Promise(resolve => { release = resolve; });
  const old = app.click('detailed');
  await flush();
  app.copyHook = null;
  await app.click('analysis');
  const winningText = app.text;
  const winningStatus = app.status;
  release(); await old;
  assert.equal(app.text, winningText);
  assert.equal(app.status, winningStatus);
  assert.equal(app.insertions.length, 1);
});

for (const mode of ['triage', 'note']) {
  test(`the original ${mode} opening can be explicitly recovered after auto insertion stops`, async () => {
    const app = await launch({ hash: hashFor({ ...jobA, mode }), composerReady: false });
    const opening = app.clipboard;
    app.location.pathname = '/u/2/app/recovery';
    await app.tick();
    assert.equal(app.text, '');
    app.composerReady = true;
    app.allow = true;
    await app.click('opening');
    assert.equal(app.text, opening);
    assert.equal(app.insertions.length, 1);
    assert.match(app.status, /^已貼上/);
    assert.ok(app.text.includes(jobA.url));
  });
}

test('continuation confirmation depends on the action, not the initial mode', async () => {
  const triage = await launch({ job: { ...jobA, mode: 'triage' } });
  const note = await launch({ job: { ...jobA, mode: 'note' } });
  await triage.click('continue'); await note.click('continue');
  assert.equal(note.confirmations[0], triage.confirmations[0]);
  assert.equal(note.text, '');
  assert.equal(triage.text, '');
});

for (const editorKind of ['textarea', 'contenteditable']) {
  for (const automatic of [false, true]) {
    test(`${editorKind}: ${automatic ? 'automatic' : 'manual'} partial insertion is retained with safe replacement instructions and no retry`, async () => {
      const app = await launch({ job: automatic ? undefined : jobA, hash: automatic ? hashFor(jobA) : '',
        editorKind, transform: text => text.slice(0, 5) });
      if (automatic) await app.tick(); else await app.click('analysis');
      const partial = app.text;
      assert.equal(partial, app.clipboard.slice(0, 5));
      assert.notEqual(partial, app.clipboard);
      assert.match(app.status, /全選替換或清空/);
      assert.match(app.status, /不要直接追加/);
      const error = app.status;
      await app.tick(); await app.tick();
      assert.equal(app.text, partial);
      assert.equal(app.status, error);
      assert.equal(app.insertions.length, 1);
      app.draft('使用者接著編輯的文字');
      await app.click('analysis');
      assert.equal(app.text, '使用者接著編輯的文字');
      assert.equal(app.insertions.length, 1);
    });
  }
}

for (const newline of ['\r\n', '\r', '\u2028', '\u2029']) {
  test(`equivalent ${JSON.stringify(newline)} editor line endings are accepted without losing blank lines`, async () => {
    const app = await launch({ job: jobA, editorKind: 'contenteditable', transform: text => text.replace(/\n/g, newline) });
    await app.click('analysis');
    assert.equal(app.text, app.clipboard.replace(/\n/g, newline));
    assert.ok(app.clipboard.includes('\n\n'));
    assert.match(app.status, /^已貼上/);
  });
}

for (const tagName of ['DIV', 'P']) {
  test(`${tagName}/BR rich-editor structure preserves blank lines and indentation despite innerText rendering`, async () => {
    const app = await launch({ job: { ...jobA, mode: 'note' }, editorKind: 'contenteditable' });
    const textNode = nodeValue => ({ nodeType: 3, nodeValue });
    Object.defineProperty(app.editor, 'childNodes', { get: () => app.text
      ? app.text.split('\n').map((line, index) => index === 0 ? textNode(line) : {
        nodeType: 1, tagName, childNodes: line
          ? [textNode(line.replace(/ {2}/g, '\u00a0 '))]
          : [{ nodeType: 1, tagName: 'BR', childNodes: [] }]
      })
      : [] });
    Object.defineProperty(app.editor, 'innerText', { get: () => app.text.replace(/\n\n/g, '\n\n\n') });
    app.allow = true;
    await app.click('opening');
    assert.equal(app.text, app.clipboard);
    assert.ok(app.text.includes('\n\n'));
    assert.ok(app.text.includes('   - title:'));
    assert.match(app.status, /^已貼上/);
    assert.equal(app.insertions.length, 1);
  });
}

test('removing an internal blank line is rejected even though the title and URL remain', async () => {
  const app = await launch({ job: jobA, editorKind: 'contenteditable', transform: text => text.replace('\n\n', '\n') });
  await app.click('analysis');
  assert.ok(app.text.includes(jobA.url));
  assert.ok(app.text.includes(jobA.title));
  assert.notEqual(app.text, app.clipboard);
  assert.match(app.status, /全選替換或清空/);
  assert.equal(app.insertions.length, 1);
});

for (const automatic of [false, true]) {
  test(`${automatic ? 'automatic' : 'manual'} delivery preserves an existing user draft and still copies the prompt`, async () => {
    const app = await launch({ job: automatic ? undefined : jobA, hash: automatic ? hashFor(jobA) : '' });
    app.draft('不可覆蓋的草稿');
    if (automatic) await app.tick(); else await app.click('analysis');
    assert.equal(app.text, '不可覆蓋的草稿');
    assert.deepEqual(app.insertions, []);
    assert.ok(app.clipboard.includes(jobA.url));
    assert.match(app.status, /已有內容/);
  });
}

test('every action without a video reports an error instead of rejecting its event handler', async () => {
  const app = await launch();
  for (const action of ['analysis', 'detailed', 'continue', 'opening']) {
    await assert.doesNotReject(app.click(action));
    assert.match(app.status, /YouTube/);
  }
  assert.equal(app.text, '');
  assert.equal(app.clipboard, '');
  assert.deepEqual(app.insertions, []);
});

test('YouTube recovers from copying or opening errors and can retry successfully', async () => {
  for (const failure of ['failCopy', 'failOpen']) {
    const app = await launch({ youtube: true });
    app[failure] = true;
    await app.clickYouTube();
    await app.clickMode('triage');
    assert.deepEqual(app.opened, []);
    assert.match(app.get('rtv-youtube-button').title, /failed/);
    await app.tick();
    assert.equal(app.get('rtv-youtube-button').disabled, false);
    app[failure] = false;
    await app.clickMode('triage');
    const openedJob = JSON.parse(Buffer.from(new URL(app.opened[0]).hash.slice(5), 'base64url').toString('utf8'));
    assert.equal(openedJob.url, jobA.url);
    assert.equal(openedJob.mode, 'triage');
    assert.ok(app.clipboard.includes(jobA.url));
    await app.tick();
    assert.equal(app.get('rtv-youtube-button').disabled, false);
  }
});
