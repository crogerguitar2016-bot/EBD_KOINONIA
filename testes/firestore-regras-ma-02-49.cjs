'use strict';
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const {
  initializeTestEnvironment, assertSucceeds, assertFails
} = require('@firebase/rules-unit-testing');
const {
  doc, collection, query, limit, getDoc, getDocs, setDoc, updateDoc,
  deleteDoc, Timestamp, serverTimestamp
} = require('firebase/firestore');

const emulator = process.env.FIRESTORE_EMULATOR_HOST || '';
const address = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(emulator);
if (!address) throw new Error('O teste exige o emulador Firestore em loopback.');

const cycle = '11111111-1111-4111-8111-111111111111';
const nextCycle = '22222222-2222-4222-8222-222222222222';
const key = '33333333-3333-4333-8333-333333333333';
const id = n => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

const room = 'turmas/sintetica';
const expired = 'turmas/expirada';
const roster = `${room}/matriculas`;
const member = `${roster}/aluno`;
const consent = `${room}/consentimentos/aluno`;
const results = `${member}/resultados`;
const oldResults = `${expired}/matriculas/aluno/resultados`;
const otherResults = `${roster}/colega/resultados`;

const enrollment = (ciclo = cycle, ativa = true) => ({
  rotulo: 'Perfil sintético', ativa, autorizacaoRegistrada: ativa,
  ciclo, alteradaEm: serverTimestamp()
});
const optIn = (ciclo = cycle, chave = key) => ({
  versao: 1, escopo: 'novas-missoes', ativa: true, chave, ciclo,
  alteradoEm: serverTimestamp()
});
const empty = () => ({n: 0, a: 0, p: 0});
const result = () => ({
  versao: 1, pontuacao: 1,
  banco: 'd1bfd4c7836280250c46751c5fa84438938887b5af869a4016b478dc7e906d24',
  chave: key, ciclo: cycle, digest: 'a'.repeat(64), modo: 'estudo',
  atividade: '5', total: 5, verificado: false, recebidoEm: serverTimestamp(),
  c8: {n: 5, a: 4, p: 1200}, c9: empty(), c10: empty(), c11: empty(), c12: empty()
});

test('Matriz sintética de acesso, consentimento e retenção', async t => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-ebd-ma-0249',
    firestore: {
      host: address[1], port: Number(address[2]),
      rules: readFileSync(join(__dirname, '..', 'firestore.rules'), 'utf8')
    }
  });
  try {
    await env.clearFirestore();
    const google = (uid, verified = true, provider = 'google.com') =>
      env.authenticatedContext(uid, {
        email_verified: verified, firebase: {sign_in_provider: provider}
      }).firestore();
    const teacher = google('professor');
    const student = google('aluno');
    const colleague = google('colega');
    const outsider = google('visitante');
    const otherTeacher = google('outro-professor');
    const anonymous = env.unauthenticatedContext().firestore();

    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      const now = Date.now();
      const active = {professor: 'professor', ativa: true,
        retencaoAte: Timestamp.fromMillis(now + 86400000)};
      await setDoc(doc(db, room), active);
      await setDoc(doc(db, 'turmas/outra'), {...active, professor: 'outro-professor'});
      await setDoc(doc(db, expired), {
        ...active, retencaoAte: Timestamp.fromMillis(now - 86400000)
      });
      await setDoc(doc(db, `${expired}/matriculas/aluno`), enrollment());
      await setDoc(doc(db, `${oldResults}/${id(1)}`), result());
      await setDoc(doc(db, `${roster}/colega`), enrollment());
      await setDoc(doc(db, `${otherResults}/${id(1)}`), result());
    });

    await t.test('Matrícula, escopo e autenticação', async () => {
      await assertFails(getDoc(doc(anonymous, room)));
      await assertFails(getDoc(doc(outsider, room)));
      await assertFails(setDoc(doc(student, member), enrollment()));
      await assertFails(setDoc(doc(otherTeacher, member), enrollment()));
      await assertFails(setDoc(doc(teacher, member), {
        ...enrollment(), autorizacaoRegistrada: false
      }));
      await assertSucceeds(setDoc(doc(teacher, member), enrollment()));
      await assertSucceeds(getDoc(doc(student, room)));
      await assertSucceeds(getDoc(doc(student, member)));
      await assertFails(getDoc(doc(google('aluno', false), member)));
      await assertFails(getDoc(doc(google('aluno', true, 'password'), member)));
      await assertFails(getDoc(doc(colleague, member)));
      await assertFails(getDoc(doc(student, 'turmas/outra')));
      await assertFails(updateDoc(doc(teacher, room), {professor: 'colega'}));
      await assertSucceeds(getDocs(query(collection(teacher, roster), limit(100))));
      await assertFails(getDocs(collection(teacher, roster)));
      await assertFails(getDocs(query(collection(teacher, roster), limit(101))));
      await assertFails(getDocs(query(collection(student, roster), limit(100))));
    });

    await t.test('Consentimento, formato e imutabilidade do resultado', async () => {
      const target = doc(student, `${results}/${id(2)}`);
      await assertFails(setDoc(target, result()));
      await assertFails(setDoc(doc(colleague, consent), optIn()));
      await assertFails(setDoc(doc(student, consent), optIn(nextCycle)));
      await assertSucceeds(setDoc(doc(student, consent), optIn()));
      for (const patch of [
        {verificado: true},
        {email: 'sintetico@example.invalid'},
        {atividade: '10'},
        {c8: {n: 5, a: 6, p: 1200}},
        {recebidoEm: Timestamp.fromMillis(0)},
        {chave: nextCycle},
        {ciclo: nextCycle},
        {banco: 'b'.repeat(64)}
      ]) {
        await assertFails(setDoc(target, {...result(), ...patch}));
      }
      await assertFails(setDoc(doc(student, `${results}/id-invalido`), result()));
      await assertSucceeds(setDoc(target, result()));
      await assertSucceeds(getDoc(target));
      await assertSucceeds(getDoc(doc(teacher, target.path)));
      await assertFails(getDoc(doc(otherTeacher, target.path)));
      await assertFails(getDoc(doc(student, `${otherResults}/${id(1)}`)));
      await assertFails(getDoc(doc(colleague, target.path)));
      await assertFails(updateDoc(target, {verificado: true}));
      await assertFails(updateDoc(doc(teacher, target.path), {verificado: true}));
      await assertFails(deleteDoc(doc(teacher, target.path)));
      await assertSucceeds(getDocs(query(collection(teacher, results), limit(100))));
      await assertFails(getDocs(collection(teacher, results)));
      await assertFails(getDocs(query(collection(student, results), limit(100))));
    });

    await t.test('Renovação, revogação e fim da retenção', async () => {
      const target = doc(student, `${results}/${id(3)}`);
      await assertFails(setDoc(doc(teacher, member), enrollment()));
      await assertSucceeds(setDoc(doc(teacher, member), enrollment(nextCycle)));
      await assertFails(setDoc(target, result()));
      await assertFails(setDoc(doc(student, consent), optIn(nextCycle, key)));
      const renewedKey = id(20);
      await assertSucceeds(setDoc(doc(student, consent), optIn(nextCycle, renewedKey)));
      await assertSucceeds(setDoc(target, {...result(), ciclo: nextCycle, chave: renewedKey}));
      await assertSucceeds(updateDoc(doc(student, consent), {
        ativa: false, alteradoEm: serverTimestamp()
      }));
      await assertFails(setDoc(doc(student, `${results}/${id(4)}`), {
        ...result(), ciclo: nextCycle, chave: renewedKey
      }));
      await assertSucceeds(setDoc(doc(teacher, member), enrollment(id(21), false)));
      await assertFails(getDoc(target));
      await assertFails(setDoc(doc(student, consent), optIn(id(21), id(22))));
      await assertSucceeds(deleteDoc(doc(teacher, target.path)));
      const retained = `${oldResults}/${id(1)}`;
      await assertFails(getDoc(doc(student, retained)));
      await assertFails(getDoc(doc(teacher, retained)));
      await assertFails(getDocs(query(collection(teacher, oldResults), limit(100))));
      await assertSucceeds(deleteDoc(doc(teacher, retained)));
    });
  } finally {
    await env.cleanup();
  }
});
