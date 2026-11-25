'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'public', 'pwa.js'), 'utf8');
const manifest = JSON.parse(readFileSync(
  join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8',
));
const scopes = ['https://example.github.io/EBD_KOINONIA/', 'http://localhost:8000/'];

function events(properties = {}) {
  const listeners = new Map();
  return Object.assign({
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    emit(name, event) {
      return Promise.all((listeners.get(name) || []).map(listener => listener.call(this, event)));
    },
  }, properties);
}

// Modela as declarações inline simples usadas pelo cliente.
function inlineStyle() {
  const declarations = new Map();
  const normalize = name => name.startsWith('--') ? name : name.toLowerCase();
  return {
    get cssText() {
      return Array.from(declarations, ([name, { value, priority }]) =>
        `${name}: ${value}${priority ? ' !important' : ''};`).join(' ');
    },
    set cssText(css) {
      declarations.clear();
      for (const declaration of css.split(';')) {
        const separator = declaration.indexOf(':');
        if (separator === -1) continue;
        const name = normalize(declaration.slice(0, separator).trim());
        const raw = declaration.slice(separator + 1).trim();
        const important = /!\s*important$/i;
        const priority = important.test(raw) ? 'important' : '';
        const value = raw.replace(important, '').trimEnd();
        if (!name || !value) continue;
        if (priority || declarations.get(name)?.priority !== 'important') {
          declarations.set(name, { value, priority });
        }
      }
    },
    getPropertyValue(name) {
      return declarations.get(normalize(name))?.value ?? '';
    },
    removeProperty(name) {
      const key = normalize(name);
      const value = this.getPropertyValue(key);
      declarations.delete(key);
      return value;
    },
  };
}

function element(tag) {
  return events({
    tag,
    children: [],
    hidden: false,
    style: inlineStyle(),
    textContent: '',
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
  });
}

async function start(base, options = {}) {
  const worker = new URL('sw.js', base).href;
  const window = events({
    isSecureContext: options.secure !== false,
    matchMedia() { return events({ matches: !!options.standalone }); },
  });
  const registration = events({ scope: base, installing: null, waiting: null, active: null });
  const calls = [];
  const serviceWorker = events({
    controller: null,
    async register(url, settings) {
      calls.push([url, settings.scope, settings.updateViaCache]);
      if (options.fail) throw new Error('registro indisponível');
      return registration;
    },
  });
  const document = {
    body: element('body'),
    currentScript: { src: options.script || new URL('pwa.js', base).href },
    createElement: element,
  };
  const location = new URL(options.page || base);
  location.reload = () => assert.fail('recarregamento forçado');
  const candidate = state => events({
    scriptURL: worker,
    state,
    postMessage() { assert.fail('mensagem inesperada ao worker'); },
  });
  if (options.waiting) registration.waiting = candidate('installed');
  const context = {
    document, window, location, URL, setTimeout,
    navigator: { serviceWorker, userAgent: options.ua || 'Android', maxTouchPoints: 0 },
  };
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'fetch']) {
    Object.defineProperty(context, name, {
      get() { assert.fail(`acesso inesperado a ${name}`); },
    });
  }
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  const [controls, update] = document.body.children;
  const [, offline, instructions, install] = controls?.children || [];
  return { window, registration, serviceWorker, candidate, calls, offline, instructions, install, update };
}

for (const base of scopes) {
  test(`manifesto, registro, modo offline e atualização em ${base}`, async () => {
    const manifestURL = new URL('manifest.webmanifest', base);
    assert.equal(new URL(manifest.start_url, manifestURL).href, `${base}index.html`);
    assert.equal(new URL(manifest.scope, manifestURL).href, base);
    assert.equal(new URL(manifest.id, new URL(base).origin).pathname, '/EBD_KOINONIA/');

    const app = await start(base, { page: `${base}estudo-biblico.html` });
    assert.deepEqual(app.calls, [[`${base}sw.js`, base, 'none']]);
    assert.match(app.offline.textContent, /ficará disponível/);
    assert.equal(app.update.hidden, true);
    assert.equal(app.update.style.getPropertyValue('display'), '');
    assert.equal(app.update.style.getPropertyValue('max-width'), '42rem');

    app.serviceWorker.controller = app.candidate('activated');
    await app.serviceWorker.emit('controllerchange');
    assert.match(app.offline.textContent, /offline disponível/);

    app.registration.installing = app.candidate('installing');
    await app.registration.emit('updatefound');
    assert.equal(app.update.hidden, true);
    const installing = app.registration.installing;
    installing.state = 'installed';
    await installing.emit('statechange');
    assert.equal(app.update.hidden, true);
    app.registration.waiting = installing;
    app.registration.installing = null;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(app.update.hidden, false);
    assert.match(app.update.textContent, /depois que todas as páginas/);

    const openedWithUpdate = await start(base, { waiting: true });
    assert.equal(openedWithUpdate.update.hidden, false);
  });
}

test('instalação opcional, instruções e sessão instalada', async () => {
  const app = await start(scopes[0]);
  assert.match(app.instructions.textContent, /Android/);
  assert.equal(app.install.hidden, true);
  let prevented = 0;
  let prompts = 0;
  const installEvent = outcome => ({
    preventDefault() { prevented++; },
    async prompt() { prompts++; },
    userChoice: Promise.resolve({ outcome }),
  });
  await app.window.emit('beforeinstallprompt', installEvent('dismissed'));
  assert.equal(prevented, 1);
  assert.equal(prompts, 0);
  assert.equal(app.install.hidden, false);
  await app.install.emit('click');
  await app.install.emit('click');
  assert.equal(prompts, 1);
  assert.equal(app.instructions.hidden, false);
  await app.window.emit('beforeinstallprompt', installEvent('accepted'));
  await app.install.emit('click');
  assert.equal(prompts, 2);
  assert.equal(app.install.hidden, true);
  assert.equal(app.instructions.hidden, true);

  const ios = await start(scopes[0], { ua: 'iPhone' });
  assert.match(ios.instructions.textContent, /Compartilhar/);
  const installed = await start(scopes[0], { standalone: true });
  assert.equal(installed.instructions.hidden, true);
});

test('contextos imprevistos e falha de registro', async () => {
  for (const [base, options] of [
    ['http://example.test/', {}],
    [scopes[0], { secure: false }],
    [scopes[0], { script: 'https://other.test/pwa.js' }],
    [scopes[0], { page: 'https://example.github.io/outra/' }],
  ]) {
    assert.deepEqual((await start(base, options)).calls, []);
  }
  const failed = await start(scopes[0], { fail: true });
  assert.match(failed.offline.textContent, /Não foi possível/);
  assert.match(failed.instructions.textContent, /Android/);
});
