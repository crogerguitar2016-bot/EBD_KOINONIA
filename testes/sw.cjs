'use strict';

const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = process.argv[1] === '--stdin' ?
  JSON.parse(fs.readFileSync(0, 'utf8')) :
  (() => {
    const root = path.join(__dirname, '..', 'public');
    // Confirma o tipo pelo caminho, assim como o inventário Python.
    const resources = fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .map(entry => path.relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep).join('/'))
      .filter(name => fs.lstatSync(path.join(root, name)).isFile());
    return {
      worker: fs.readFileSync(path.join(root, 'sw.js'), 'utf8'),
      files: Object.fromEntries(resources.filter(name => name !== 'sw.js' && name !== '.nojekyll')
        .map(name => [name, fs.readFileSync(path.join(root, name)).toString('base64')])),
    };
  })();

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = new Map(Object.entries(source.files)
  .map(([name, base64]) => [name, Buffer.from(base64, 'base64')]));
const scopes = ['https://example.github.io/EBD_KOINONIA/', 'http://localhost:8000/'];
const bogus = '0'.repeat(64);

function environment(base) {
  const stores = new Map();
  const server = new Map(bytes);
  const log = [];
  let fault = '';
  let failedPut = '';

  const caches = {
    async has(name) { return stores.has(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(url) { return entries.get(url)?.clone(); },
        async put(url, response) {
          if (url.endsWith(failedPut) && failedPut) throw new Error('quota simulada');
          entries.set(url, response.clone());
        },
      };
    },
  };

  async function fetch(url, options) {
    log.push({ url, options });
    if (fault === 'rede') throw new TypeError('rede indisponível');
    const name = url.slice(base.length) || 'index.html';
    const data = server.get(name);
    const status = fault === 'http' ? 503 : data ? 200 : 404;
    const response = new Response(data, { status });
    Object.defineProperty(response, 'url', { value: url });
    if (fault === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
    return response;
  }

  function load(worker = source.worker, scope = base) {
    const handlers = new Map();
    vm.runInNewContext(worker, {
      self: {
        location: new URL('sw.js', base),
        registration: { scope },
        addEventListener(name, handler) { handlers.set(name, handler); },
        skipWaiting() { assert.fail('ativação forçada'); },
        clients: { claim() { assert.fail('controle forçado'); } },
      },
      URL, Response, AbortController, crypto: webcrypto, setTimeout, clearTimeout,
      caches, fetch,
    });

    return {
      lifecycle(name) {
        let promise;
        handlers.get(name)({ waitUntil(value) { promise = value; } });
        assert.ok(promise);
        return promise;
      },
      request(url, { mode = 'navigate', method = 'GET', headers = {} } = {}) {
        let promise;
        handlers.get('fetch')({
          request: { url, mode, method, headers: new Headers(headers) },
          respondWith(value) { promise = value; },
        });
        return promise;
      },
    };
  }

  return {
    stores, server, log, load,
    fault(value) { fault = value; },
    failPut(value) { failedPut = value; },
  };
}

function nextRelease(replacements) {
  let worker = source.worker.replace(
    /const RELEASE = '[a-f0-9]{64}';/,
    `const RELEASE = '${sha(Buffer.from('segunda versão simulada'))}';`,
  );
  for (const [name, data] of replacements) {
    const previous = sha(bytes.get(name));
    assert.ok(worker.includes(previous));
    worker = worker.replace(previous, sha(data));
  }
  return worker;
}

for (const base of scopes) {
  test(`inventário, navegação, modo offline e privacidade em ${base}`, async () => {
    const env = environment(base);
    const sw = env.load();
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
    assert.equal(env.stores.size, 1);
    const entries = [...env.stores.values()][0];
    assert.deepEqual([...entries.keys()].sort(),
      [...bytes.keys()].map(name => new URL(name, base).href).sort());
    for (const [url, response] of entries) {
      assert.deepEqual(Buffer.from(await response.clone().arrayBuffer()), bytes.get(url.slice(base.length)));
    }

    const index = Buffer.from(await (await sw.request(base)).arrayBuffer());
    assert.deepEqual(index, bytes.get('index.html'));
    assert.equal(env.log.at(-1).url, base);
    for (const { options } of env.log) {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      assert.equal(options.referrerPolicy, 'no-referrer');
    }

    for (const fault of ['rede', 'http', 'redirect']) {
      env.fault(fault);
      for (const route of ['', 'index.html', 'estudo-biblico.html', 'principais-textos.html']) {
        const response = await sw.request(base + route);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.get(route || 'index.html'));
      }
    }

    const script = await sw.request(base + 'questoes-v03.js', { mode: 'same-origin' });
    assert.deepEqual(Buffer.from(await script.arrayBuffer()), bytes.get('questoes-v03.js'));
    entries.delete(base + 'estudo-biblico.html');
    const fallback = await sw.request(base + 'estudo-biblico.html');
    assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), bytes.get('offline.html'));
    entries.delete(base + 'offline.html');
    assert.equal((await sw.request(base + 'estudo-biblico.html')).status, 503);
    entries.delete(base + 'questoes-v03.js');
    assert.equal((await sw.request(base + 'questoes-v03.js', { mode: 'same-origin' })).type, 'error');

    const requests = env.log.length;
    for (const [url, options] of [
      ['https://wa.me/?text=resultado', {}],
      ['https://www.biblegateway.com/passage/', {}],
      ['https://other.example/questoes-v03.js', { mode: 'cors' }],
      [new URL('../outra-pagina.html', base).href, {}],
      [base + 'index.html?nome=Ana&pontuacao=5', {}],
      [base + 'index.html?', {}],
      [base + 'index.html', { method: 'POST' }],
      [base + 'index.html', { headers: { Authorization: 'valor' } }],
      [base + 'questoes-v03.js', { headers: { Range: 'bytes=0-1' } }],
    ]) assert.equal(sw.request(url, options), undefined);
    assert.equal(env.log.length, requests);
  });

  test(`atualização sem mistura e instalação reversível em ${base}`, async () => {
    const env = environment(base);
    const old = env.load();
    await old.lifecycle('install');
    const [oldName] = env.stores.keys();
    const prefix = oldName.slice(0, -64);
    const otherScope = base.endsWith('/EBD_KOINONIA/') ? new URL('/', base).href :
      new URL('outro/', base).href;
    const other = `ebd-koinonia-pwa:${encodeURIComponent(otherScope)}:${bogus}`;
    const unrelated = [other, 'cache-de-outro-app', prefix + 'reserva'];
    for (const name of unrelated) env.stores.set(name, new Map());

    const changed = new Map([
      ['index.html', Buffer.concat([bytes.get('index.html'), Buffer.from('\n<!-- V2 -->')])],
      ['questoes-v03.js', Buffer.concat([bytes.get('questoes-v03.js'), Buffer.from('\n// V2')])],
    ]);
    const nextWorker = nextRelease(changed);
    const next = env.load(nextWorker);
    const previousNames = await env.stores.keys();

    env.fault('rede');
    await assert.rejects(next.lifecycle('install'), /rede/);
    env.fault('');
    await assert.rejects(next.lifecycle('install'), /Conteúdo divergente/);
    assert.deepEqual(await env.stores.keys(), previousNames);

    for (const [name, data] of changed) env.server.set(name, data);
    env.failPut('offline.html');
    await assert.rejects(next.lifecycle('install'), /quota/);
    assert.deepEqual(await env.stores.keys(), previousNames);
    env.failPut('');

    await next.lifecycle('install');
    assert.ok(env.stores.has(oldName));
    assert.deepEqual(Buffer.from(await (await old.request(base)).arrayBuffer()), bytes.get('index.html'));
    const oldScript = await old.request(base + 'questoes-v03.js', { mode: 'same-origin' });
    assert.deepEqual(Buffer.from(await oldScript.arrayBuffer()), bytes.get('questoes-v03.js'));

    env.stores.set(prefix + bogus, new Map());
    await next.lifecycle('activate');
    assert.equal(env.stores.has(oldName), false);
    assert.equal(env.stores.has(prefix + bogus), false);
    for (const name of unrelated) assert.ok(env.stores.has(name));
    assert.equal(env.stores.size, unrelated.length + 1);
    env.fault('rede');
    assert.deepEqual(Buffer.from(await (await next.request(base)).arrayBuffer()), changed.get('index.html'));
    const script = await next.request(base + 'questoes-v03.js', { mode: 'same-origin' });
    assert.deepEqual(Buffer.from(await script.arrayBuffer()), changed.get('questoes-v03.js'));
  });
}

test('recusa registro com escopo diferente do diretório do worker', () => {
  const env = environment(scopes[0]);
  assert.throws(() => env.load(source.worker, 'https://example.github.io/'), /escopo/);
});
