'use strict';
(() => {
  const core = globalThis.EBDTurmaCore;
  const adultClass = 'koinonia-adultos';
  const adultName = 'Koinonia Adultos';
  const data = globalThis.EBDAlunoDados;
  const configURL = new URL('turma-config.json', document.currentScript.src);
  const base = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const dialog = document.querySelector('#turma-dialog');
  const opener = document.querySelector('#turma-open');
  const content = document.querySelector('#turma-content');
  const status = document.querySelector('#turma-status');
  let session, modules, armed, selectedProfile, syncing, timer;
  let busy = false;
  let epoch = 0;
  let report = [];

  function notice(text) { status.textContent = text; }

  function el(tag, text) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function button(text, task) {
    const item = el('button', text);
    item.type = 'button';
    item.onclick = () => perform(task);
    return item;
  }

  function field(parent, label, type = 'text') {
    const wrapper = el('label', label + ' ');
    const input = el('input');
    input.type = type;
    input.autocomplete = 'off';
    input.style.maxWidth = '100%';
    if (type === 'text') input.maxLength = 128;
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }

  function clear() {
    report = [];
    content.replaceChildren();
  }

  async function perform(task) {
    if (busy) return;
    busy = true;
    content.inert = true;
    notice('');
    try { await task(); }
    catch (e) {
      notice(e.safe || ({
        'permission-denied': 'Acesso negado ou autorização expirada.',
        'unavailable': 'Serviço indisponível. Confira a conexão.',
        'auth/popup-blocked': 'Permita a janela de autenticação e tente novamente.',
        'auth/popup-closed-by-user': 'Entrada cancelada.'
      })[e.code] || 'Operação indisponível. Confira a conexão e a configuração da turma.');
    } finally {
      busy = false;
      content.inert = false;
    }
  }

  function stop(message) { throw Object.assign(new Error(message), {safe: message}); }

  async function initialize() {
    if (modules) return modules;
    const response = await fetch(configURL, {credentials: 'omit', cache: 'no-store'});
    if (!response.ok) stop('Configuração do modo turma indisponível.');
    const settings = await response.json();
    if (settings.enabled !== true) stop('Modo turma desativado. Os modos locais continuam disponíveis.');
    const {firebase} = settings;
    if (!/^[a-z][a-z0-9-]{4,29}$/.test(firebase?.projectId) ||
      firebase.authDomain !== firebase.projectId + '.firebaseapp.com' ||
      !/^AIza[\w-]{30,}$/.test(firebase.apiKey) ||
      !/^1:\d+:web:[a-f0-9]+$/.test(firebase.appId)) stop('Configuração pública do Firebase inválida.');
    const [appAPI, authAPI, fs] = await Promise.all([
      import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'),
      import(base + 'firebase-firestore.js')
    ]);
    const app = appAPI.initializeApp(firebase, 'ebd-turma');
    const auth = authAPI.initializeAuth(app, {
      persistence: authAPI.inMemoryPersistence,
      popupRedirectResolver: authAPI.browserPopupRedirectResolver
    });
    const db = fs.initializeFirestore(app, {localCache: fs.memoryLocalCache()});
    authAPI.onAuthStateChanged(auth, user => {
      if (session && session.uid !== user?.uid) {
        epoch++;
        session = armed = undefined;
        clear();
        if (dialog.open) welcome();
      }
    });
    modules = {authAPI, auth, fs, db};
    return modules;
  }

  function welcome() {
    clear();
    content.append(el('p', 'Use uma conta Google com e-mail verificado para acessar o modo turma. A sessão termina ao fechar ou recarregar a página.'));
    content.append(button('Entrar com Google', async () => {
      const {authAPI, auth} = await initialize();
      const provider = new authAPI.GoogleAuthProvider();
      provider.setCustomParameters({prompt: 'select_account'});
      const {user} = await authAPI.signInWithPopup(auth, provider);
      const token = await user.getIdTokenResult();
      if (!user.emailVerified || token.signInProvider !== 'google.com') {
        await authAPI.signOut(auth);
        stop('Use uma conta Google com e-mail verificado.');
      }
      session = {uid: user.uid};
      account();
      kick();
    }));
  }

  function ensure(expected, generation = epoch) {
    if (session !== expected || modules.auth.currentUser?.uid !== expected?.uid ||
        generation !== epoch) stop('Sessão alterada. Entre novamente.');
  }

  function refs(c, uid) {
    const {db, fs} = modules;
    return {
      turma: fs.doc(db, 'turmas', c),
      member: fs.doc(db, 'turmas', c, 'matriculas', uid),
      consent: fs.doc(db, 'turmas', c, 'consentimentos', uid),
      results: fs.collection(db, 'turmas', c, 'matriculas', uid, 'resultados')
    };
  }

  async function read(ref) {
    const snap = await modules.fs.getDocFromServer(ref);
    return snap.data();
  }

  function classCode(input) {
    const code = input.value.trim();
    if (!core.scope.test(code)) stop('Informe o código da turma fornecido pelo professor.');
    return code;
  }

  async function enrollAdult(current, alias) {
    ensure(current);
    if (!alias) stop('Informe um apelido para identificação no painel privado do professor.');
    const {fs, db} = modules;
    const ref = refs(adultClass, current.uid).member;
    const cycle = crypto.randomUUID();
    const created = await fs.runTransaction(db, async tx => {
      ensure(current);
      const saved = (await tx.get(ref)).data();
      ensure(current);
      if (saved) {
        if (!saved.ativa || !saved.autorizacaoRegistrada) {
          stop('Matrícula bloqueada ou indisponível. Consulte o professor.');
        }
        return false;
      }
      tx.set(ref, {rotulo: alias, ativa: true, autorizacaoRegistrada: true,
        ciclo: cycle, alteradaEm: fs.serverTimestamp(), matriculadaEm: fs.serverTimestamp()});
      return true;
    }, {maxAttempts: 3});
    ensure(current);
    await student(current, adultClass);
    notice(created
      ? 'Matrícula confirmada. Você pode escolher se deseja autorizar o envio de novas missões.'
      : 'Sua matrícula já está registrada.');
  }

  function account() {
    clear();
    const current = session;
    const adults = el('details');
    adults.append(el('summary', adultName), el('p',
      'Com as inscrições abertas, o apelido informado fica visível no painel privado do professor. Você decide separadamente se quer enviar resultados de novas missões.'));
    const alias = field(adults, 'Apelido para a matrícula');
    adults.append(button('Matricular-me', () => enrollAdult(current, data.normalizeName(alias.value))),
      button('Consultar minha matrícula em Koinonia Adultos', () => student(current, adultClass)),
      button('Painel do professor de Koinonia Adultos', () => teacher(current, adultClass)));
    content.append(adults);
    const code = field(content, 'Código da turma');
    content.append(button('Consultar matrícula', () => student(current, classCode(code))),
      button('Abrir painel do professor', () => teacher(current, classCode(code))),
      button('Sair da conta Google', async () => {
        armed = undefined;
        session = undefined;
        epoch++;
        welcome();
        await modules.authAPI.signOut(modules.auth);
      }));
    const details = el('details');
    details.append(el('summary', 'Meu código para matrícula'), el('p', current.uid),
      el('p', 'Envie esse código ao professor por um canal privado.'));
    content.append(details);
  }

  async function student(current, c) {
    ensure(current);
    const {fs} = modules;
    const ref = refs(c, current.uid);
    const member = await read(ref.member);
    ensure(current);
    if (!member) stop('Matrícula indisponível nesta turma.');
    const consent = await read(ref.consent);
    ensure(current);
    const canJoin = member.ativa && member.autorizacaoRegistrada;
    const turma = canJoin ? await read(ref.turma).catch(error => {
      if (error.code !== 'permission-denied') throw error;
      return undefined;
    }) : undefined;
    ensure(current);
    clear();
    content.append(el('h3', c === adultClass ? adultName : 'Turma ' + c),
      el('p', 'O professor recebe a modalidade, a atividade e os totais por capítulo. Os resultados são calculados neste dispositivo e marcados como não verificados. Somente missões iniciadas após a adesão podem entrar na fila.'),
      el('p', turma ? 'Prazo de retenção informado pela turma: ' +
        turma.retencaoAte.toDate().toLocaleString('pt-BR') + '. Solicitações sobre dados já recebidos devem ser encaminhadas ao professor.' :
        'Matrícula indisponível para novos envios.'));
    if (turma) {
      content.append(button('Aceitar envio de novas missões deste perfil', async () => {
        ensure(current);
        const profile = selectedProfile;
        if (!profile) stop('Abra primeiro um perfil do modo acompanhado.');
        const enrolled = await read(ref.member);
        ensure(current);
        if (profile !== selectedProfile || !enrolled?.ativa || !enrolled.autorizacaoRegistrada) {
          stop('Perfil ou matrícula alterados. Consulte a turma novamente.');
        }
        const saved = await read(ref.consent);
        ensure(current);
        const key = saved?.ativa && saved.ciclo === enrolled.ciclo ? saved.chave : crypto.randomUUID();
        if (!(saved?.ativa && saved.ciclo === enrolled.ciclo)) {
          await fs.setDoc(ref.consent, {versao: 1, escopo: 'novas-missoes', ativa: true,
            chave: key, ciclo: enrolled.ciclo, alteradoEm: fs.serverTimestamp()});
        }
        const confirmed = await read(ref.consent);
        ensure(current);
        if (profile !== selectedProfile || !confirmed?.ativa ||
            confirmed.chave !== key || confirmed.ciclo !== enrolled.ciclo) {
          stop('A adesão mudou. Consulte a turma novamente.');
        }
        armed = {profile, project: modules.db.app.options.projectId,
          uid: current.uid, c, key, cycle: enrolled.ciclo,
          until: turma.retencaoAte.toMillis()};
        notice('Modo turma ativo neste perfil para as próximas missões.');
        kick();
      }));
    }
    if (consent) content.append(button('Revogar consentimento e descartar envios pendentes', async () => {
      ensure(current);
      if (!confirm('Revogar a autorização nesta turma e descartar envios pendentes neste navegador?')) return;
      if (armed?.uid === current.uid && armed.c === c) armed = undefined;
      await data.classCancel(modules.db.app.options.projectId, current.uid, c);
      await fs.updateDoc(ref.consent, {ativa: false, alteradoEm: fs.serverTimestamp()});
      const confirmed = await read(ref.consent);
      ensure(current);
      if (confirmed?.ativa !== false) stop('Revogação ainda sem confirmação. Tente novamente conectado.');
      await student(current, c);
      notice('Revogação confirmada. Consulte o professor sobre os resultados já recebidos.');
    }));
    content.append(button('Pausar novas missões de turma neste perfil', () => {
      if (armed?.c === c) armed = undefined;
      notice('Novas missões seguem no modo acompanhado local.');
    }), button('Atualizar fila e recibos', async () => {
      ensure(current);
      await kick(true);
      ensure(current);
      const rows = await data.classRows();
      const project = modules.db.app.options.projectId;
      const counts = state => rows.filter(row =>
        row.binding?.project === project && row.binding.uid === current.uid &&
        row.binding.c === c && row.classState === state).length;
      notice(`${counts('pending')} pendentes · ${counts('sent')} com recibo · ${counts('blocked')} bloqueados.`);
    }), button('Voltar à conta', account));
  }

  function profileChanged(profile) {
    if (selectedProfile !== profile) armed = undefined;
    selectedProfile = profile;
  }

  function start(profile) {
    if (!armed || armed.profile !== profile || armed.uid !== session?.uid ||
        Date.now() >= armed.until) return undefined;
    return {...armed};
  }

  function packet(attempt, result) { return core.summarize(attempt, result); }

  function kick(manual = false) {
    if (!session || !modules || !navigator.onLine) return Promise.resolve();
    if (syncing) return syncing;
    clearTimeout(timer);
    const current = session;
    const generation = epoch;
    syncing = drain(current, generation, manual).catch(() => {
      if (session === current) timer = setTimeout(kick, 15000);
    }).finally(() => {
      syncing = undefined;
      if (session && session !== current) kick();
    });
    return syncing;
  }

  function retransmission(count) {
    return Date.now() + Math.min(30 * 60 * 1000, 3000 * 2 ** Math.min(count, 10))
      + Math.floor(Math.random() * 2500);
  }

  async function drain(current, generation, manual) {
    const {fs, db} = modules;
    const project = db.app.options.projectId;
    const rows = (await data.classRows()).filter(row => row.binding?.project === project &&
      row.binding.uid === current.uid && row.classState === 'pending');
    let earliest = Infinity;
    for (const row of rows) {
      ensure(current, generation);
      if (!navigator.onLine) break;
      if (!manual && row.nextAt > Date.now()) {
        earliest = Math.min(earliest, row.nextAt);
        continue;
      }
      const lease = crypto.randomUUID();
      if (!await data.classClaim(row.id, lease, Date.now(), manual)) {
        earliest = Math.min(earliest, Date.now() + 15000);
        continue;
      }
      const {binding, payload, attemptId} = row;
      let patch;
      try {
        ensure(current, generation);
        if (Date.now() >= binding.until) {
          patch = {classState: 'blocked', reason: 'prazo'};
        } else {
          const destination = refs(binding.c, binding.uid);
          const remote = fs.doc(destination.results, attemptId);
          const authorized = {...payload, chave: binding.key, ciclo: binding.cycle};
          const digest = await core.digest(authorized);
          ensure(current, generation);
          const matching = value => value && value.digest === digest &&
            Object.keys(authorized).every(key =>
              JSON.stringify(value[key], Object.keys(value[key] ?? {}).sort()) ===
              JSON.stringify(authorized[key], Object.keys(authorized[key] ?? {}).sort()));
          await fs.runTransaction(db, async tx => {
            ensure(current, generation);
            const existing = (await tx.get(remote)).data();
            ensure(current, generation);
            if (existing) {
              if (!matching(existing)) throw Object.assign(new Error(), {code: 'ebd/conflito'});
            } else {
              tx.set(remote, {...authorized, digest, recebidoEm: fs.serverTimestamp()});
            }
          }, {maxAttempts: 3});
          ensure(current, generation);
          const remoteValue = await read(remote);
          ensure(current, generation);
          if (!matching(remoteValue) || !remoteValue.recebidoEm) throw new Error('recibo');
          patch = {classState: 'sent', receipt: {
            turma: binding.c, tentativa: attemptId, digest,
            recebidoEm: remoteValue.recebidoEm.toDate().toISOString()
          }};
        }
      } catch (error) {
        if (['permission-denied', 'ebd/conflito', 'invalid-argument'].includes(error.code)) {
          patch = {classState: 'blocked', reason: error.code};
        } else {
          const tries = (row.tries || 0) + 1;
          patch = {classState: 'pending', tries, nextAt: retransmission(tries)};
          earliest = Math.min(earliest, patch.nextAt);
        }
      }
      await data.classSettle(row.id, lease, patch);
      if (session !== current) return;
    }
    if (earliest < Infinity && session === current) {
      timer = setTimeout(kick, Math.max(1000, earliest - Date.now()));
    }
  }

  async function pages(ref, constraints, current, generation, ceiling) {
    const {fs} = modules;
    let cursor;
    const documents = [];
    do {
      ensure(current, generation);
      const query = fs.query(ref, ...constraints, ...(cursor ? [fs.startAfter(cursor)] : []), fs.limit(100));
      const page = await fs.getDocsFromServer(query);
      ensure(current, generation);
      documents.push(...page.docs);
      if (documents.length > ceiling) stop('Consulta extensa. Reduza o período ou selecione um aluno.');
      cursor = page.size === 100 ? page.docs.at(-1) : undefined;
    } while (cursor);
    return documents;
  }

  function localDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  async function teacher(current, c) {
    ensure(current);
    const {fs, db} = modules;
    const turma = await read(refs(c, current.uid).turma);
    ensure(current);
    if (turma?.professor !== current.uid) stop('Painel disponível ao professor autorizado desta turma.');
    clear();
    content.append(el('h3', 'Painel privado · ' + (c === adultClass ? adultName : 'Turma ' + c)),
      el('p', 'Resultados não verificados. O período usa a data de recebimento no fuso deste dispositivo.'));
    const roster = fs.collection(db, 'turmas', c, 'matriculas');
    const students = await pages(roster, [fs.orderBy(fs.documentId())], current, epoch, 500);
    const labels = new Map(students.map(doc => [doc.id, doc.data().rotulo]));

    if (c === adultClass) {
      const admissions = el('section');
      const opened = turma.inscricoesAbertas === true;
      admissions.append(el('h4', 'Novas matrículas'),
        el('p', opened ? 'Inscrições abertas.' : 'Inscrições fechadas.'),
        button(opened ? 'Fechar inscrições' : 'Abrir inscrições', async () => {
          ensure(current);
          if (!opened && !confirm('Abrir matrícula para contas Google verificadas?')) return;
          await fs.updateDoc(refs(c, current.uid).turma, {inscricoesAbertas: !opened});
          ensure(current);
          await teacher(current, c);
          notice(opened ? 'Inscrições fechadas.' : 'Inscrições abertas.');
        }));
      const recent = students.filter(doc => doc.data().matriculadaEm)
        .sort((a, b) => b.data().matriculadaEm.toMillis() - a.data().matriculadaEm.toMillis());
      if (recent.length) {
        const list = el('ul');
        for (const doc of recent) {
          const row = doc.data();
          list.append(el('li', row.rotulo + ' · ' + doc.id.slice(-6) + ' · ' +
            row.matriculadaEm.toDate().toLocaleString('pt-BR') + ' · ' +
            (row.ativa ? 'ativa' : 'bloqueada')));
        }
        admissions.append(list);
      } else {
        admissions.append(el('p', 'Nenhuma matrícula automática registrada.'));
      }
      admissions.append(button('Atualizar matrículas', () => teacher(current, c)));
      content.append(admissions);
    }

    const admin = el('details');
    admin.append(el('summary', 'Administrar matrículas'));
    const uid = field(admin, 'Código Google do aluno');
    const label = field(admin, 'Código pedagógico ou apelido');
    const approval = field(admin, 'Registrei a autorização aplicável, inclusive do responsável quando exigida', 'checkbox');
    const picker = el('select');
    picker.setAttribute('aria-label', 'Selecionar matrícula para administração');
    picker.append(new Option('Nova matrícula ou código informado', ''));
    for (const doc of students) picker.append(new Option(
      doc.data().rotulo + ' · ' + (doc.data().ativa ? 'ativa' :
        c === adultClass ? 'bloqueada' : 'revogada'), doc.id));
    picker.onchange = () => {
      uid.value = picker.value;
      label.value = labels.get(picker.value) || '';
      approval.checked = false;
    };
    admin.append(picker, button('Autorizar ou renovar matrícula', async () => {
      const studentUID = uid.value.trim();
      const alias = data.normalizeName(label.value);
      if (!core.scope.test(studentUID) || studentUID === current.uid || !alias || !approval.checked) {
        stop('Confira o código do aluno, o apelido e o registro da autorização.');
      }
      const member = refs(c, studentUID).member;
      const saved = await read(member);
      if (saved?.ativa && !confirm('Renovar a matrícula cancela a autorização de envios ainda pendentes no ciclo anterior. Continuar?')) return;
      ensure(current);
      await fs.setDoc(member, {rotulo: alias, ativa: true, autorizacaoRegistrada: true,
        ...(c === adultClass && saved?.matriculadaEm ? {matriculadaEm: saved.matriculadaEm} : {}),
        ciclo: crypto.randomUUID(), alteradaEm: fs.serverTimestamp()});
      await teacher(current, c);
      notice('Matrícula autorizada.');
    }), button(c === adultClass ? 'Bloquear matrícula' : 'Revogar matrícula', async () => {
      const studentUID = uid.value.trim();
      if (!core.scope.test(studentUID) || !confirm('Bloquear novos envios deste aluno nesta turma?')) return;
      ensure(current);
      await fs.updateDoc(refs(c, studentUID).member, {ativa: false,
        autorizacaoRegistrada: false, ciclo: crypto.randomUUID(), alteradaEm: fs.serverTimestamp()});
      await teacher(current, c);
      notice(c === adultClass ? 'Matrícula bloqueada.' : 'Matrícula revogada.');
    }));
    content.append(admin);

    const filters = el('section');
    const selectLabel = el('label', 'Aluno ');
    const select = el('select');
    select.append(new Option('Todos da turma', ''));
    for (const [id, name] of labels) select.append(new Option(name + ' · ' + id.slice(-6), id));
    selectLabel.append(select);
    filters.append(selectLabel);
    const from = field(filters, 'Recebido a partir de', 'date');
    const to = field(filters, 'Recebido até', 'date');
    const end = new Date();
    const begin = new Date(end);
    begin.setDate(begin.getDate() - 29);
    const dateInput = d => [d.getFullYear(), d.getMonth() + 1, d.getDate()]
      .map(n => String(n).padStart(2, '0')).join('-');
    from.value = dateInput(begin);
    to.value = dateInput(end);
    const results = el('div');
    const exportButton = button('Exportar relatório CSV', () => {
      ensure(current);
      if (!report.length || Date.now() >= turma.retencaoAte.toMillis()) {
        stop('Atualize a consulta dentro do prazo de retenção.');
      }
      const url = URL.createObjectURL(new Blob([core.csv(report)], {type: 'text/csv;charset=utf-8'}));
      const link = el('a');
      link.href = url;
      link.download = 'ebd-relatorio-' + c + '.csv';
      document.body.append(link);
      try { link.click(); }
      finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    });
    const invalidate = () => {
      results.replaceChildren();
      report = [];
      exportButton.disabled = true;
    };
    exportButton.disabled = true;
    for (const input of [from, to, select]) input.onchange = invalidate;
    filters.append(button('Consultar desempenho', async () => {
      invalidate();
      ensure(current);
      const generation = epoch;
      const lower = localDate(from.value);
      const upper = localDate(to.value);
      upper.setDate(upper.getDate() + 1);
      if (!from.value || !to.value || !(lower < upper)) stop('Informe um período válido.');
      const constraints = [fs.where('recebidoEm', '>=', lower),
        fs.where('recebidoEm', '<', upper), fs.orderBy('recebidoEm')];
      const rows = [];
      for (const id of select.value ? [select.value] : labels.keys()) {
        for (const doc of await pages(refs(c, id).results, constraints, current, generation, 2000 - rows.length)) {
          rows.push({id, name: labels.get(id), result: doc.data()});
        }
      }
      ensure(current, generation);
      renderReport(results, c, rows);
      exportButton.disabled = rows.length === 0;
    }), exportButton, results);
    content.append(filters, button('Selecionar outra turma', account));
  }

  function renderReport(parent, c, rows) {
    report = [['Turma', 'Aluno', 'Código do aluno', 'Recebido em UTC', 'Atividade', 'Modalidade',
      'Capítulo', 'Respondidas', 'Acertos', 'Pontos', 'Verificação']];
    if (!rows.length) {
      parent.append(el('p', 'Nenhum resultado recebido no período.'));
      return;
    }
    const groups = new Map();
    const add = (dimension, key, label, counts) => {
      if (!groups.has(dimension)) groups.set(dimension, new Map());
      const group = groups.get(dimension);
      const sum = group.get(key) || {label, n: 0, a: 0, p: 0};
      for (const k of ['n', 'a', 'p']) sum[k] += counts[k];
      group.set(key, sum);
    };
    for (const {id, name, result} of rows) {
      const total = core.stats(result);
      add('Turma', c, c, total);
      add('Alunos', id, name + ' · ' + id.slice(-6), total);
      add('Atividades', result.atividade + result.modo, result.atividade + ' · ' + result.modo, total);
      for (const chapter of core.chapters) {
        const bucket = result['c' + chapter];
        if (!bucket.n) continue;
        add('Capítulos', chapter, 'Atos ' + chapter, bucket);
        report.push([c, name, id, result.recebidoEm.toDate().toISOString(), result.atividade,
          result.modo, chapter, bucket.n, bucket.a, bucket.p, 'Não verificado']);
      }
    }
    parent.append(el('p', rows.length + (rows.length === 1 ? ' missão recebida' : ' missões recebidas') + ' · Resultados não verificados'));
    for (const [dimension, group] of groups) {
      const list = el('ul');
      for (const {label, n, a, p} of group.values()) {
        list.append(el('li', `${label} · ${a}/${n} acertos (${Math.round(100 * a / n)}%) · ${p} pontos`));
      }
      parent.append(el('h3', dimension), list);
    }
  }

  opener.onclick = () => {
    if (readerLocked()) return;
    dialog.showModal();
    if (session) account();
    else welcome();
  };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (!busy) clear();
  });
  new MutationObserver(() => { opener.disabled = navBible.disabled; })
    .observe(navBible, {attributes: true, attributeFilter: ['disabled']});
  window.addEventListener('online', () => kick());
  window.addEventListener('pageshow', () => kick());
  globalThis.EBDTurma = Object.freeze({profileChanged, start, packet, kick});
})();
