'use strict';

const RELEASE = '3443d566e9347eef25bdaaf83bdc2c9fa3c2ae8070087f411140f2ac5589bd8d';
const FILES = {
  "estudo-biblico.html": {
    "mime": "text/html; charset=utf-8",
    "sha256": "e7dfe20a5b5154b3dfc31f94ec2587bd38133aa1e737591fd49b6b94e447e79e"
  },
  "explorar.css": {
    "mime": "text/css; charset=utf-8",
    "sha256": "c983578e4fdaa9ad34fcda32bd99c3653806ef6d0fc6bc9ba1fbf28204b6272f"
  },
  "explorar.js": {
    "mime": "text/javascript; charset=utf-8",
    "sha256": "23bb089ba5a2bac113f5081143886d75a737a15c44f353a7f529f31e7ebbade7"
  },
  "icons/apple-touch-icon.png": {
    "mime": "image/png",
    "sha256": "a72fa01038b92190fd126ff5de4bbdd4a5a911678d00d23859e7eaf710de953c"
  },
  "icons/icon-192.png": {
    "mime": "image/png",
    "sha256": "a8f70790bd03540f9ffe36052df6c5a7d621695d7c8b70eddfa4f5b020c5cf4d"
  },
  "icons/icon-512.png": {
    "mime": "image/png",
    "sha256": "990ea6c6c0995c13dad3b2455d396f0075469680e609b7c48ff9b3035eebacbe"
  },
  "icons/icon-maskable.png": {
    "mime": "image/png",
    "sha256": "990ea6c6c0995c13dad3b2455d396f0075469680e609b7c48ff9b3035eebacbe"
  },
  "index.html": {
    "mime": "text/html; charset=utf-8",
    "sha256": "d1ab7f2a2aad53d3d95e403dad837c8f2df7ebd83421d7a530d493e9ad09d13c"
  },
  "manifest.webmanifest": {
    "mime": "application/manifest+json",
    "sha256": "6158a48323ad0e1710bd7c3ff0d4fa73538d5173b86449b281833d574733f9e9"
  },
  "offline.html": {
    "mime": "text/html; charset=utf-8",
    "sha256": "ca70dcbf67f5120d8d1f5a6004377114ef96aa80f2b30f9f9efa05ef54108042"
  },
  "principais-textos.html": {
    "mime": "text/html; charset=utf-8",
    "sha256": "c1b9df6790300bff9d8245249dff322f4368ec3d4eab4fa604f4cd6dbea4eb8c"
  },
  "pwa.js": {
    "mime": "text/javascript; charset=utf-8",
    "sha256": "cc7f5684658127b6fb9eb3b270eb317a63a3a4d6b7dc55a4cf7ed78c7d486046"
  },
  "questoes-v03.js": {
    "mime": "text/javascript; charset=utf-8",
    "sha256": "d1bfd4c7836280250c46751c5fa84438938887b5af869a4016b478dc7e906d24"
  }
};
const PAGES = new Set(["estudo-biblico.html", "index.html", "principais-textos.html"]);
const SCOPE = new URL(self.registration.scope);

if (SCOPE.href !== new URL('./', self.location.href).href) {
  throw new Error('O escopo deve corresponder ao diretório do aplicativo.');
}

const PREFIX = `ebd-koinonia-pwa:${encodeURIComponent(SCOPE.href)}:`;
const CACHE_NAME = PREFIX + RELEASE;
const ASSETS = new Map(Object.entries(FILES).map(([name, file]) => [
  new URL(name, SCOPE).href, { ...file, name },
]));
const HOME = new URL('index.html', SCOPE).href;
const OFFLINE = new URL('offline.html', SCOPE).href;

async function download(url, file) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (response.status !== 200 || response.redirected || response.url !== url) {
      throw new Error(`Resposta inválida para ${file.name}`);
    }

    const bytes = await response.arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== file.sha256) {
      throw new Error(`Conteúdo divergente para ${file.name}`);
    }

    // Guarda apenas o conteúdo estático verificado e cabeçalhos definidos aqui.
    return new Response(bytes, {
      headers: {
        'Content-Type': file.mime,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function install() {
  if (await caches.has(CACHE_NAME)) {
    const existing = await caches.open(CACHE_NAME);
    const entries = await Promise.all([...ASSETS.keys()].map(url => existing.match(url)));
    if (entries.every(Boolean)) return;
  }

  // Valida a versão inteira antes da primeira gravação. O navegador só pode
  // ativar este worker depois que a promessa de instalação for concluída.
  const entries = await Promise.all([...ASSETS].map(async ([url, file]) => [
    url, await download(url, file),
  ]));
  const cache = await caches.open(CACHE_NAME);
  try {
    for (const [url, response] of entries) {
      await cache.put(url, response);
    }
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

self.addEventListener('install', event => event.waitUntil(install()));

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name =>
      name !== CACHE_NAME &&
      name.startsWith(PREFIX) &&
      /^[a-f0-9]{64}$/.test(name.slice(PREFIX.length))
    ).map(name => caches.delete(name)));
  })());
});

async function cached(url) {
  if (!(await caches.has(CACHE_NAME))) return undefined;
  const cache = await caches.open(CACHE_NAME);
  return cache.match(url);
}

async function navigate(url, key, file) {
  try {
    return await download(url, file);
  } catch {
    // Uma implantação nova pode chegar à rede enquanto há atividades na
    // versão anterior. Seus bytes só são servidos pelo worker correspondente.
    return (await cached(key)) || (await cached(OFFLINE)) || new Response(
      'EBD KOINONIA temporariamente indisponível.',
      {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      },
    );
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' ||
      request.headers.has('authorization') ||
      request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;

  const navigation = request.mode === 'navigate';
  const key = navigation && url.href === SCOPE.href ? HOME : url.href;
  const file = ASSETS.get(key);
  // A lista exata deixa consultas, páginas desconhecidas e links externos
  // seguirem o comportamento normal do navegador.
  if (!file) return;

  if (navigation && PAGES.has(file.name)) {
    event.respondWith(navigate(url.href, key, file));
  } else if (!navigation || key === OFFLINE) {
    event.respondWith(cached(key).then(response => response || Response.error()));
  }
});
