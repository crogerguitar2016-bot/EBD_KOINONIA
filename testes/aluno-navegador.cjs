'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.EBD_PLAYWRIGHT || 'playwright');
const url = process.argv[2];

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.EBD_CHROMIUM || undefined
  });
  try {

    async function confirmAction(page, name) {
      await page.locator('#aluno-confirm').getByRole('button', {name, exact: true}).click();
    }
    const profileButton = async (page, id, remembered = false) => {
      const row = await page.evaluate(async id =>
        (await EBDAlunoDados.roster()).find(row => row.id === id), id);
      assert.ok(row);
      const label = row.name || 'Perfil ' + row.number;
      return page.locator('.aluno-profile-list').getByRole('button', {
        name: 'Abrir ' + label + (remembered ? ' · lembrado' : ''), exact: true
      });
    };
    async function openDetails(page, label) {
      const summary = page.locator('summary').filter({hasText: new RegExp('^' + label + '$')});
      if (!await summary.evaluate(el => el.parentElement.open)) await summary.click();
    }
    async function fits(page) {
      for (const width of [320, 360, 375, 390, 412, 480, 768, 1024]) {
        for (const height of [300, 800]) {
          await page.setViewportSize({width, height});
          const exceeds = await page.evaluate(() => {
            const viewport = document.documentElement.clientWidth;
            const panel = document.querySelector('#aluno-confirm[open]') || document.querySelector('.aluno-panel, .aluno-results');
            return document.documentElement.scrollWidth > viewport + 1 ||
              Boolean(panel && panel.scrollWidth > panel.clientWidth + 1);
          });
          assert.equal(exceeds, false, 'Rolagem horizontal em ' + width + ' × ' + height);
        }
      }
    }
    const context = await browser.newContext({acceptDownloads: true});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(url);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

    const open = () => page.locator('#aluno-open').click();
    const create = async () => {
      await openDetails(page, 'Criar perfil');
      await page.getByLabel('Nome ou apelido (opcional)').fill('Aluna <b>Teste</b>');
      await page.getByRole('button', {name: /Aceito guardar/}).evaluate(el => { el.click(); el.click(); });
    };
    const mission = () => page.getByRole('button', {name: /Desafio rápido/}).click();
    const idle = () => page.waitForFunction(() => !document.querySelector('main').inert);
    const ids = () => page.evaluate(() => EBDAlunoDados.keysList());
    const get = id => page.evaluate(id => EBDAlunoDados.get(id), id);
    const queue = id => page.evaluate(id => new Promise((resolve, reject) => {
      const request = indexedDB.open(EBDAlunoDados.dbName, 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('queue');
        const read = tx.objectStore('queue').index('profileId').getAll(id);
        tx.oncomplete = () => { db.close(); resolve(read.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), id);

    // Sem abrir o modo acompanhado, o quiz livre não abre o IndexedDB.
    await mission();
    await page.locator('.option').first().click();
    assert.equal(await page.evaluate(async () => (await indexedDB.databases()).length), 0);
    await page.reload();
    assert.equal(await page.getByRole('button', {name: 'Retomar atividade'}).count(), 0);

    // Pré-carrega um perfil concluído no esquema real v1. A aplicação migra para v2.
    const seed = await page.evaluate(async () => {
      const model = EBDAlunoDados;
      const p = model.createProfile();
      const bankVersion = (await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode('banco antigo para teste')));
      const hex = Array.from(new Uint8Array(bankVersion), n => n.toString(16).padStart(2, '0')).join('');
      const questions = window.EBD_QUESTOES_V03.slice(0, 5);
      p.history.push({
        id: crypto.randomUUID(), owner: p.id, bankVersion: hex, mode: 'estudo',
        elapsed: 6000, index: 4, finished: new Date().toISOString(), questions,
        items: questions.map(q => ({id: q.id, order: q.alternativas.map((_, i) => i),
          choice: q.indiceRespostaCorreta, hint: false, consults: 0, assistedConsults: 0}))
      });
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(model.dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('profiles', {keyPath: 'id'}).add(p);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { request.result.close(); resolve(); };
      });
      return p.id;
    });

    await open();
    await (await profileButton(page, seed)).waitFor();
    assert.equal((await queue(seed)).length, 1);
    await create();
    await idle();
    const all = await ids();
    assert.equal(all.length, 2);
    const first = all.find(id => id !== seed);
    assert.equal(await page.evaluate(id => EBDAlunoDados.identity(id), first), 'Aluna <b>Teste</b>');
    await open();
    await openDetails(page, 'Editar identificação');
    await page.getByLabel('Nome ou apelido (opcional)').fill('Estudante ' + 'm'.repeat(55));
    await page.getByRole('button', {name: 'Salvar identificação'}).click();
    await page.getByText('Identificação atualizada.').waitFor();
    assert.equal(await page.locator('#view b').count(), 0);
    assert.equal((await page.locator('#view').innerText()).includes(first), false);
    const renamed = await page.evaluate(id => EBDAlunoDados.identity(id), first);
    assert.equal(await page.locator('.aluno-panel h3').textContent(), renamed);
    assert.equal(await page.locator('#aluno-mode').textContent(), 'Modo acompanhado · ' + renamed);
    await fits(page);
    await page.getByRole('button', {name: 'Continuar atividade'}).click();
    await mission();
    await idle();
    const title = await page.locator('#question-title').textContent();
    const options = await page.locator('.option').allTextContents();
    await page.getByRole('button', {name: 'Revelar pista'}).click();
    await idle();
    await page.locator('.option').first().click();
    await idle();
    const partial = await get(first);
    assert.equal(partial.active.items[0].choice, 0);
    assert.equal(partial.active.items[0].hint, true);
    await context.setOffline(true);

    // A nova aba depende do cache do SW e da restauração real do IndexedDB.
    const restoredPage = await context.newPage();
    await page.close();
    restoredPage.on('pageerror', error => errors.push(error.message));
    restoredPage.on('dialog', dialog => dialog.accept());
    await restoredPage.goto(url);
    await restoredPage.locator('#aluno-open').click();
    await (await profileButton(restoredPage, first)).click();
    await restoredPage.getByRole('button', {name: 'Retomar atividade'}).click();
    const wait = () => restoredPage.waitForFunction(() => !document.querySelector('main').inert);
    await wait();
    assert.equal(await restoredPage.locator('#question-title').textContent(), title);
    assert.deepEqual(
      (await restoredPage.locator('.option').allTextContents()).map(text =>
        text.replace(/ — (sua resposta|resposta correta)$/, '')), options);
    const resumed = await restoredPage.evaluate(id => EBDAlunoDados.get(id), first);
    assert.equal(resumed.active.index, partial.active.index);
    assert.deepEqual(resumed.active.items, partial.active.items);
    assert.ok(resumed.active.elapsed >= partial.active.elapsed);
    await restoredPage.getByRole('button', {name: 'Continuar', exact: true}).click();
    await wait();
    for (let i = 1; i < 5; i++) {
      await restoredPage.locator('.option').first().click();
      await wait();
      await restoredPage.getByRole('button', {name: i === 4 ? 'Concluir' : 'Continuar', exact: true}).click();
      await wait();
    }
    await restoredPage.getByRole('heading', {name: 'Missão concluída!'}).waitFor();
    assert.equal(await restoredPage.getByText('Compartilhar resultado').count(), 0);

    const other = await context.newPage();
    await other.goto(url);
    await other.locator('#aluno-open').click();
    await (await profileButton(other, first)).click();
    await other.getByRole('button', {name: /Desafio rápido/}).click();
    await other.waitForFunction(() => !document.querySelector('main').inert);
    const saved = await other.evaluate(id => EBDAlunoDados.get(id), first);
    const cas = await other.evaluate(async profile => {
      try {
        await EBDAlunoDados.write(profile, profile.rev - 1);
        return false;
      } catch (error) {
        return error instanceof EBDAlunoDados.Conflict;
      }
    }, saved);
    assert.equal(cas, true);
    await other.close();

    const manage = () => restoredPage.locator('#aluno-open').click();
    await manage();
    await restoredPage.getByRole('button', {name: 'Meu desempenho'}).click();
    await restoredPage.getByRole('heading', {name: 'Painel individual de desempenho'}).waitFor();
    await manage();
    const downloaded = restoredPage.waitForEvent('download');
    await openDetails(restoredPage, 'Gerenciar meus dados');
    await restoredPage.getByRole('button', {name: 'Salvar cópia de segurança'}).click();
    const dl = await downloaded;
    const bytes = fs.readFileSync(await dl.path());
    await wait();
    // A outra aba alterou a revisão. A exclusão exige reabrir a revisão atual.
    await openDetails(restoredPage, 'Gerenciar meus dados');
    await restoredPage.getByRole('button', {name: 'Excluir perfil', exact: true}).click();
    await confirmAction(restoredPage, 'Excluir perfil');
    await restoredPage.waitForFunction(() => document.querySelector('#aluno-status').textContent.includes('mudou'));
    await restoredPage.reload();
    await manage();
    await (await profileButton(restoredPage, first)).click();
    await manage();
    await openDetails(restoredPage, 'Gerenciar meus dados');
    await restoredPage.getByRole('button', {name: 'Excluir perfil', exact: true}).click();
    await confirmAction(restoredPage, 'Excluir perfil');
    await restoredPage.getByText('Perfil excluído deste navegador.').waitFor();
    assert.deepEqual(await restoredPage.evaluate(() => EBDAlunoDados.keysList()), [seed]);

    await openDetails(restoredPage, 'Restaurar progresso');
    const file = restoredPage.locator('#aluno-import-file');
    const restore = () => restoredPage.getByRole('button', {name: 'Conferir e restaurar arquivo'}).click();
    await file.setInputFiles({name: 'corrompido.json', mimeType: 'application/json',
      buffer: Buffer.from('{}')});
    await restore();
    await restoredPage.getByText('Arquivo inválido, corrompido ou incompatível com esta versão.').waitFor();
    assert.deepEqual(await restoredPage.evaluate(() => EBDAlunoDados.keysList()), [seed]);

    await file.setInputFiles({name: 'progresso.json', mimeType: 'application/json', buffer: bytes});
    await restore();
    await confirmAction(restoredPage, 'Restaurar progresso');
    await restoredPage.getByText('Perfil restaurado.').waitFor();
    const restoredProfile = await restoredPage.evaluate(id => EBDAlunoDados.get(id), first);
    assert.equal(restoredProfile.history.length, 1);
    assert.equal(restoredProfile.history[0].owner, first);
    assert.equal(restoredProfile.active.owner, first);
    assert.equal((await restoredPage.evaluate(id => EBDAlunoDados.get(id), seed)).history[0].owner, seed);

    const queued = await restoredPage.evaluate(id => new Promise((resolve, reject) => {
      const open = indexedDB.open(EBDAlunoDados.dbName, 2);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('queue');
        const read = tx.objectStore('queue').index('profileId').getAll(id);
        tx.oncomplete = () => { db.close(); resolve(read.result); };
      };
    }), first);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].attemptId, restoredProfile.history[0].id);

    await manage();
    await openDetails(restoredPage, 'Gerenciar meus dados');
    await openDetails(restoredPage, 'Restaurar progresso');
    await restoredPage.locator('#aluno-import-file').setInputFiles({
      name: 'arquivo-' + 'muito-longo-'.repeat(16) + '.json',
      mimeType: 'application/json', buffer: bytes
    });
    await fits(restoredPage);
    await restore();
    await fits(restoredPage);
    await restoredPage.keyboard.press('Escape');
    await wait();
    assert.equal((await restoredPage.evaluate(id => EBDAlunoDados.get(id), first)).rev, restoredProfile.rev);
    await restore();
    await confirmAction(restoredPage, 'Restaurar progresso');
    await restoredPage.getByText('Perfil restaurado.').waitFor();
    assert.deepEqual(await restoredPage.evaluate(id => EBDAlunoDados.get(id), first), restoredProfile);
    assert.equal(await restoredPage.evaluate(id => EBDAlunoDados.identity(id), first), '');
    await manage();
    await restoredPage.getByRole('button', {name: 'Meu desempenho'}).click();
    const expected = await restoredPage.evaluate(id => EBDAlunoDados.get(id).then(profile =>
      makeResult(profile.history[0], profile.history[0].finished)), first);
    await restoredPage.locator('.aluno-results details summary').first().click();
    assert.match(await restoredPage.locator('.aluno-results details').first().innerText(),
      new RegExp(expected.points + ' pontos'));
    assert.match(await restoredPage.locator('.aluno-results details').first().innerText(),
      new RegExp(expected.score + '/' + expected.total + ' acertos'));
    await fits(restoredPage);
    await manage();
    await openDetails(restoredPage, 'Gerenciar meus dados');
    const remember = restoredPage.getByLabel('Lembrar meu perfil neste dispositivo');
    assert.equal(await remember.isChecked(), false);
    await remember.check();
    await remember.uncheck();
    assert.equal(await remember.isChecked(), false);
    assert.equal(await restoredPage.evaluate(() =>
      Object.keys(localStorage).some(key => key.startsWith('ebd-koinonia:perfil-lembrado:'))), false);
    await remember.check();
    await restoredPage.reload();
    await restoredPage.getByText('Modo livre', {exact: true}).waitFor();
    await manage();
    await (await profileButton(restoredPage, first, true)).click();
    await manage();
    await restoredPage.getByRole('button', {name: 'Voltar ao modo livre'}).click();
    await restoredPage.reload();
    await manage();
    await (await profileButton(restoredPage, first)).waitFor();
    assert.equal(await restoredPage.getByRole('button', {name: /lembrado$/}).count(), 0);

    // A e B reais, mesma origem e contexto, com atividade em andamento.
    if (process.env.EBD_VARIANTE) {
      const versionContext = await browser.newContext();
      const versionA = await versionContext.newPage();
      fs.writeFileSync(process.env.EBD_VARIANTE, 'A');
      await versionA.goto(url);
      await versionA.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await versionA.reload();
      await versionA.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await versionA.locator('#aluno-open').click();
      await openDetails(versionA, 'Criar perfil');
      await versionA.getByRole('button', {name: /Aceito guardar/}).click();
      await versionA.getByRole('button', {name: /Desafio rápido/}).click();
      await versionA.waitForFunction(() => !document.querySelector('main').inert);
      await versionA.locator('.option').first().click();
      await versionA.waitForFunction(() => !document.querySelector('main').inert);
      const saved = await versionA.evaluate(async () => {
        const [id] = await EBDAlunoDados.keysList();
        return EBDAlunoDados.get(id);
      });
      fs.writeFileSync(process.env.EBD_VARIANTE, 'B');
      await versionA.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
      await versionA.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
      assert.equal(await versionA.locator('#question-title').count(), 1);
      assert.equal(await versionA.locator('#aluno-confirm').count(), 1);
      assert.equal(await versionA.locator('#aluno-confirm[open]').count(), 0);
      await versionA.close();
      const versionB = await versionContext.newPage();
      await versionB.goto(url);
      await versionB.waitForSelector('#aluno-confirm', {state: 'attached'});
      await versionB.waitForFunction(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active?.state === 'activated' &&
          !registration.waiting && navigator.serviceWorker.controller === registration.active;
      });
      await versionContext.setOffline(true);
      await versionB.reload();
      await versionB.locator('#aluno-open').click();
      await (await profileButton(versionB, saved.id)).click();
      await versionB.getByRole('button', {name: 'Retomar atividade', exact: true}).click();
      const recovered = await versionB.evaluate(id => EBDAlunoDados.get(id), saved.id);
      assert.deepEqual(recovered.active.items, saved.active.items);
      assert.deepEqual(recovered.active.questions, saved.active.questions);
      await versionContext.close();
    }

    await pageContextScenario(browser, url);
    assert.deepEqual(errors, []);
    console.log('Chromium real: modo livre, IndexedDB v1→v2, SW offline, retomada, conclusão, conflito, exclusão e restauração.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });


async function scenario(labeler) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const same = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), message);
  const db = globalThis.EBDAlunoDados;
  const bank = globalThis.EBD_QUESTOES_V03;
  const byId = new Map(bank.map(q => [q.id, q]));
  const version = 'a'.repeat(64);
  const seed = db.createProfile();
  await db.write(seed, null);
  const firstNumber = (await db.roster()).find(row => row.id === seed.id).number;
  const one = await db.write(db.createProfile(), null, 'Aluno Teste');
  const two = await db.write(db.createProfile(), null, 'Aluno Teste');
  const long = await db.write(db.createProfile(), null, '📝'.repeat(70));
  const rows = await db.roster();
  const labels = labeler(rows);
  same(labels.get(seed.id), 'Perfil ' + firstNumber, 'Número anônimo instável');
  assert(labels.get(one.id) !== labels.get(two.id), 'Homônimos fundidos');
  assert(labels.get(one.id).startsWith('Aluno Teste · Perfil '), 'Homônimo sem rótulo');
  same(labels.get(long.id), '📝'.repeat(60), 'Nome longo alterado');
  for (const value of labels.values()) {
    assert(!/[a-f0-9]{12}/i.test(value), 'Código técnico visível');
  }
  await db.remove(two.id, two.rev);
  same(labeler(await db.roster()).get(one.id), 'Aluno Teste', 'Nome único com sufixo');
  same((await db.roster()).find(row => row.id === seed.id).number, firstNumber,
    'Número mudou após exclusão');
  same(await db.get(one.id), one, 'Registro ou UUID alterado por apresentação');

  const questions = bank.slice(0, 5);
  const items = questions.map(q => ({
    id: q.id, order: q.alternativas.map((_, index) => index),
    choice: q.indiceRespostaCorreta, hint: false, consults: 0, assistedConsults: 0
  }));
  const attempt = {id: crypto.randomUUID(), owner: one.id, mode: 'estudo',
    elapsed: 69000, index: 4, bankVersion: version, items, questions,
    finished: new Date().toISOString()};
  const saved = await db.write({...one, history: [attempt]}, one.rev);
  const encoded = await db.encode(saved);
  const imported = await db.decode(encoded, version, byId);
  for (let repeat = 0; repeat < 2; repeat++) {
    same(await db.write(imported, null), saved, 'Importação repetida alterou dados');
  }
  same((await db.queueReferences(one.id)).map(row => row.attemptId), [attempt.id],
    'Referência de tentativa duplicada');
  same((await db.get(one.id)).history.map(row => row.id), [attempt.id],
    'Histórico duplicado, com risco de pontos duplicados');
  let rejected = false;
  try { await db.write({...imported, history: []}, null); }
  catch (error) { rejected = error instanceof db.Conflict; }
  assert(rejected, 'Restauração em conflito aceita');
  same(await db.get(one.id), saved, 'Conflito sobrescreveu dados');

  await db.remove(one.id, saved.rev);
  same(await db.get(one.id), undefined, 'Perfil excluído ainda existe');
  same(await db.identity(one.id), '', 'Nome excluído ainda existe');
  same(await db.queueReferences(one.id), [], 'Fila do perfil excluído ainda existe');
  same(await db.get(seed.id), seed, 'Exclusão afetou outro perfil');
  const recreated = await db.write(imported, null);
  same(recreated.id, one.id, 'Backup mudou UUID');
  same(recreated.history.length, 1, 'Restauração após exclusão duplicou missão');
  same(labeler(await db.roster()).get(seed.id), 'Perfil ' + firstNumber,
    'Restauração mudou a numeração de outro perfil');
}

async function pageContextScenario(browser, url) {
  const context = await browser.newContext({serviceWorkers: 'block'});
  try {
    const page = await context.newPage();
    const {source, scenarioSource} = {
      source: fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'aluno.js'), 'utf8'),
      scenarioSource: scenario.toString()
    };
    const labels = source.slice(source.indexOf('  function friendlyNames('),
      source.indexOf('  async function profileLabel('));
    const fixture = new URL('__ensaio-0133.html', url).href;
    const fixtureScript = new URL('__ensaio-0133.js', url).href;
    await page.route(fixture, route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<script src="questoes-v03.js"></script><script src="aluno-dados.js"></script>' +
        '<script src="__ensaio-0133.js"></script>'
    }));
    await page.route(fixtureScript, route => route.fulfill({
      contentType: 'text/javascript; charset=utf-8',
      body: labels + '\n' + scenarioSource +
        '\nglobalThis.ensaio0133 = () => scenario(friendlyNames);'
    }));
    await page.goto(fixture);
    await page.evaluate(() => globalThis.ensaio0133());
  } finally { await context.close(); }
}
