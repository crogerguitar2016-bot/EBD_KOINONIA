
'use strict';
const assert = require('node:assert/strict');
const {chromium} = require(process.env.EBD_PLAYWRIGHT || 'playwright');
const [url, enabled] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch({executablePath: process.env.EBD_CHROMIUM || undefined});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const remote = [];
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin === new URL(url).origin) return route.continue();
      remote.push(target.origin);
      return route.abort();
    });
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    if (enabled !== 'true') {
      await page.getByRole('button', {name: 'Modo turma', exact: true}).click();
      await page.getByRole('button', {name: 'Entrar com Google'}).click();
      await page.getByText(/Modo turma desativado/).waitFor();
      await page.getByRole('button', {name: 'Fechar modo turma'}).click();
    }
    assert.deepEqual(remote, []);
    await page.evaluate(async () => {
      const equal = (a, b) => {
        if (a !== b) throw new Error(`${a} != ${b}`);
      };
      const db = EBDAlunoDados;
      const core = EBDTurmaCore;
      const binding = {project:'sintetico', uid:'googleTeste', c:'turmaA',
        key:crypto.randomUUID(), cycle:crypto.randomUUID(), until:Date.now()+600000};
      let profile = await db.write(db.createProfile(), null);
      binding.profile = profile.id;
      const newAttempt = () => {
        const questions = structuredClone(EBD_QUESTOES_V03.slice(0, 5));
        return {id:crypto.randomUUID(), owner:profile.id, bankVersion:'a'.repeat(64),
          mode:'estudo', elapsed:0, index:4, questions, finished:null,
          items:questions.map(q => ({id:q.id, order:[0, 1, 2],
            choice:q.indiceRespostaCorreta, hint:false, consults:0, assistedConsults:0}))};
      };
      const legacy = newAttempt();
      legacy.finished = new Date().toISOString();
      profile = await db.write({...profile, history:[legacy]}, profile.rev);
      equal((await db.classRows()).length, 0);
      const attempt = newAttempt();
      profile = await db.write({...profile, active:attempt}, profile.rev, '',
        {started:{id:attempt.id, binding}});
      equal((await db.classRows())[0].classState, 'started');
      attempt.finished = new Date().toISOString();
      const payload = core.summarize(attempt, makeResult(attempt, attempt.finished));
      equal(payload.verificado, false);
      equal(core.stats(payload).a, 5);
      profile = await db.write({...profile, active:null, history:[legacy, attempt]}, profile.rev, '',
        {finished:{id:attempt.id, payload}});
      const [pending] = await db.classRows();
      equal(pending.classState, 'pending');
      equal((await db.queueReferences(profile.id)).length, 3);
      const claimed = await Promise.all([
        db.classClaim(pending.id, 'aba-1', Date.now(), true),
        db.classClaim(pending.id, 'aba-2', Date.now(), true)
      ]);
      equal(claimed.filter(Boolean).length, 1);
      await db.classCancel(binding.project, binding.uid, binding.c);
      await db.classSettle(pending.id, claimed[0] ? 'aba-1' : 'aba-2',
        {classState:'sent', receipt:{digest:'teste'}});
      const [revoked] = await db.classRows();
      equal(revoked.classState, 'blocked');
      equal(revoked.payload, undefined);
      equal(await core.digest({z:1, a:2}), await core.digest({a:2, z:1}));
      equal(core.csv([['=1+1', 2]]), '\uFEFF"\'=1+1","2"\r\n');
      await db.remove(profile.id, profile.rev);
      equal((await db.classRows()).length, 0);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(remote, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
