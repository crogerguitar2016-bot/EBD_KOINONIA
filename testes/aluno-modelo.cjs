'use strict';
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
Object.defineProperty(globalThis, 'crypto', {value: webcrypto});
globalThis.window = globalThis;
require('../public/aluno-dados.js');
require('../public/questoes-v03.js');

(async () => {
  const db = globalThis.EBDAlunoDados;
  const bank = globalThis.EBD_QUESTOES_V03;
  const byId = new Map(bank.map(q => [q.id, q]));
  const version = 'a'.repeat(64);
  assert.equal(db.normalizeName('  Aluna\u0301   <b>  '), 'Aluná <b>');
  assert.equal(db.normalizeName('📝'.repeat(70)), '📝'.repeat(60));
  const p = db.createProfile();
  const second = db.createProfile();
  assert.notEqual(p.id, second.id);
  const questions = bank.slice(0, 5);
  const items = questions.map(q => ({
    id: q.id, order: q.alternativas.map((_, i) => i).reverse(), choice: null,
    hint: false, consults: 0, assistedConsults: 0
  }));
  items[0].choice = 1;
  p.active = {id: webcrypto.randomUUID(), owner: p.id, mode: 'estudo', elapsed: 12345,
    index: 1, bankVersion: version, items, questions, finished: null};
  db.validate(p, version, byId);
  const encoded = await db.encode(p);
  const restored = await db.decode(encoded, version, byId);
  assert.deepEqual(restored, p);
  await assert.rejects(db.decode(encoded.replace('12345', '12346'), version, byId));
  for (const edit of [
    copy => { copy.active.owner = second.id; },
    copy => { copy.active.items[0].order.fill(0); },
    copy => { copy.active.items[2].choice = 0; },
    copy => { copy.active.questions[0].explicacao += ' adulterado'; },
    copy => { copy.active.elapsed = -1; },
    copy => { copy.active.index = 2; },
    copy => { copy.consent.future = 'accepted'; }
  ]) {
    const mutated = structuredClone(p);
    edit(mutated);
    const withNewChecksum = await db.encode(mutated);
    await assert.rejects(db.decode(withNewChecksum, version, byId));
  }
  const finished = structuredClone(p.active);
  finished.index = 4;
  finished.finished = new Date().toISOString();
  finished.items.forEach(item => { item.choice = 0; });
  p.active = null;
  p.history = [finished, finished];
  assert.throws(() => db.validate(p, version, byId));
  p.history.pop();
  assert.equal(db.validate(p, version, byId).history.length, 1);
  console.log('Modelo em Node: portabilidade, limites, corrupção, identidade e duplicidades.');
})().catch(error => { console.error(error); process.exitCode = 1; });
