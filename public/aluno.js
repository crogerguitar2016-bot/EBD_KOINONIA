'use strict';

(() => {
  const bankVersion = 'd1bfd4c7836280250c46751c5fa84438938887b5af869a4016b478dc7e906d24';
  const data = globalThis.EBDAlunoDados;
  const landmark = document.querySelector('#aluno-mode');
  const change = document.querySelector('#aluno-open');
  const recovery = document.querySelector('#aluno-recovery');
  const status = document.querySelector('#aluno-status');
  const retry = document.querySelector('#aluno-retry');
  const reopen = document.querySelector('#aluno-reopen');
  const main = document.querySelector('main');

  const original = {home, start, resume, revealHint, answer, next, bible, stats};
  let selected = null;
  let free = null;
  let profilePanel = false;
  let busy = false;
  let draining = null;
  let pending = null;
  let failure = null;
  let savedElapsed = 0;
  let classroomTransition;

  function locking() {
    main.inert = busy || Boolean(failure);
    reader.inert = main.inert;
    retry.hidden = !failure || failure instanceof data.Conflict;
    reopen.hidden = !failure;
  }

  function modeLabel() {
    landmark.textContent = selected ? 'Modo acompanhado · ' + activeLabel : 'Modo livre';
    change.textContent = selected ? 'Perfil e dados locais' : 'Modo acompanhado';
  }

  function message(text) {
    status.textContent = text;
  }

  function latch(error) {
    failure = error;
    stopViewing();
    if (reader.open) reader.close();
    technicalError(error);
    message('Não foi possível salvar. As mudanças pendentes ainda estão nesta página.');
    locking();
    (retry.hidden ? reopen : retry).focus();
  }

  function drain() {
    if (draining || failure || !pending) return draining;
    draining = (async () => {
      while (pending) {
        const {snapshot, transition} = pending;
        pending = null;
        try {
          const saved = await data.write(snapshot, selected.rev, '', transition);
          if (transition?.finished) window.EBDTurma?.kick();
          selected.rev = saved.rev;
          savedElapsed = saved.active?.elapsed || 0;
        } catch (error) {
          pending = {snapshot: pending?.snapshot ?? snapshot,
            transition: pending?.transition ?? transition};
          latch(error);
          break;
        }
      }
    })().finally(() => { draining = null; });
    return draining;
  }

  function save() {
    if (!selected) return;
    selected = {...selected, active};
    pending = {snapshot: structuredClone(selected),
      transition: classroomTransition ?? pending?.transition};
    classroomTransition = undefined;
    return drain();
  }

  function run(operation, args = [], after) {
    if (!selected) return operation(...args);
    if (busy || failure) return;
    profilePanel = false;
    const prior = active;
    const result = operation(...args);
    if (after) after(prior);
    if (!active && !prior) return result;
    const focus = document.activeElement;
    busy = true;
    locking();
    message('Salvando...');
    Promise.resolve(save()).then(() => {
      if (!failure) message('Progresso salvo.');
    }).finally(() => {
      busy = false;
      locking();
      if (!failure && focus?.isConnected && focus !== document.body) focus.focus();
    });
    return result;
  }

  start = async (total, chapter) => {
    if (!selected) return original.start(total, chapter);
    if (busy || failure || inActivity) return;
    if (selected.history.length >= data.maxAttempts) {
      message('Limite local de missões atingido. Exporte o histórico antes de iniciar outro perfil.');
      return;
    }
    const target = selected;
    const mode = document.querySelector('#mode')?.value;
    let approved = !active;
    if (!approved) await operation(async () => {
      approved = await ask('Substituir atividade em andamento?', progressText(active) +
        '\nO progresso desta atividade será substituído.', 'Substituir atividade', true);
    });
    if (!approved || selected !== target) return;
    return run(original.start, [total, chapter, true, mode], prior => {
      if (active && active !== prior) {
        Object.assign(active, {
          id: crypto.randomUUID(), owner: selected.id, bankVersion, finished: null,
          questions: active.items.map(item => structuredClone(byId.get(item.id)))
        });
        const binding = window.EBDTurma?.start(selected.id);
        if (binding) classroomTransition = {started: {id: active.id, binding}};
      }
    });
  };
  resume = (...args) => {
    if (selected && busy) return original.resume(...args);
    return run(original.resume, args);
  };
  home = (...args) => run(original.home, args);
  answer = (...args) => run(original.answer, args);
  revealHint = (...args) => run(original.revealHint, args);
  bible = (...args) => run(original.bible, args);
  stats = (...args) => run(original.stats, args);
  next = (...args) => run(original.next, args, prior => {
    if (prior && !active) {
      prior.finished = completed.date;
      selected.history = [...selected.history, prior];
      if (window.EBDTurma) classroomTransition = {finished: {
        id: prior.id, payload: window.EBDTurma.packet(prior, completed)
      }};
    }
  });

  // start() chama a função global resume(). Dentro dessa chamada a atividade
  // ainda recebe seus metadados, portanto só a transição externa grava.
  const resumeAction = resume;
  resume = (...args) => selected && active && !active.id
    ? original.resume(...args) : resumeAction(...args);

  window.EBDAluno = {
    get selected() { return Boolean(selected); },
    summary(activity) { return progressText(activity); },
    atlas(operation) { return run(operation); }
  };

  function checkpointWhenHidden() {
    if (selected && active && active.elapsed !== savedElapsed && !failure) save();
  }

  // Os listeners do quiz executam primeiro e pausam o cronômetro.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) checkpointWhenHidden();
  });
  window.addEventListener('pagehide', checkpointWhenHidden);
  window.addEventListener('beforeunload', event => {
    if (!pending && !draining && !failure) return;
    event.preventDefault();
    event.returnValue = '';
  });
  setInterval(() => {
    if (selected && inActivity && active && !busy && !failure && !draining &&
      active.elapsed !== savedElapsed) save();
  }, 1000);

  function enter(profile) {
    data.validate(profile, bankVersion, byId);
    if (!selected) {
      free = {active, completed, records: records.slice()};
    }
    stopViewing();
    selected = profile;
    window.EBDTurma?.profileChanged(profile.id);
    active = profile.active;
    savedElapsed = active?.elapsed || 0;
    const history = profile.history.map(attempt => makeResult(attempt, attempt.finished));
    records.splice(0, records.length, ...history);
    completed = history.at(-1) || null;
    modeLabel();
    original.home();
    profilePanel = false;
  }

  function leave(forget = true) {
    if (forget) {
      try { remember(null); } catch (error) { technicalError(error); }
    }
    identification = '';
    activeLabel = '';
    if (!selected) {
      original.home();
      profilePanel = false;
      return;
    }
    stopViewing();
    selected = null;
    window.EBDTurma?.profileChanged(null);
    active = free.active;
    completed = free.completed;
    records.splice(0, records.length, ...free.records);
    free = null;
    modeLabel();
    original.home();
    profilePanel = false;
  }

  async function operation(action) {
    if (busy || failure) return;
    const previous = document.activeElement;
    message('');
    busy = true;
    locking();
    try {
      await action();
    } catch (error) {
      technicalError(error);
      message(error instanceof data.Conflict ? error.message : 'Não foi possível acessar os dados locais.');
    } finally {
      busy = false;
      locking();
      if (!failure) {
        if (previous?.isConnected && previous !== document.body) previous.focus();
        else if (profilePanel) view.querySelector('h2')?.focus();
        else change.focus();
      }
    }
  }

  const button = (label, action) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', () => operation(action));
    return element;
  };


  const scope = new URL('.', location.href).pathname;
  const rememberedKey = 'ebd-koinonia:perfil-lembrado:' + scope;
  const dialog = document.querySelector('#aluno-confirm');
  dialog.querySelectorAll('button').forEach(control => {
    control.addEventListener('click', () => dialog.close(control.value));
  });
  let identification = '';
  let activeLabel = '';
  let diagnostic = '';

  function remember(id) {
    if (id) localStorage.setItem(rememberedKey, id);
    else localStorage.removeItem(rememberedKey);
  }

  function remembered() {
    try { return localStorage.getItem(rememberedKey); }
    catch { return null; }
  }

  const countMissions = n => n === 1 ? '1 missão concluída' : n + ' missões concluídas';
  function friendlyNames(rows) {
    const normalize = name => name.normalize('NFC').toLowerCase();
    const counts = new Map();
    for (const {name} of rows) {
      if (name) counts.set(normalize(name), (counts.get(normalize(name)) || 0) + 1);
    }
    const labels = new Map();
    const used = new Set();
    for (const {id, number, name} of rows) {
      if (name) continue;
      const label = 'Perfil ' + number;
      labels.set(id, label);
      used.add(normalize(label));
    }
    const named = rows.filter(row => row.name).sort((a, b) => a.number - b.number);
    const deferred = [];
    for (const row of named) {
      const key = normalize(row.name);
      if (counts.get(key) > 1 || used.has(key)) deferred.push(row);
      else {
        labels.set(row.id, row.name);
        used.add(key);
      }
    }
    for (const {id, number, name} of deferred) {
      const base = name + ' · Perfil ' + number;
      let label = base;
      let option = 1;
      while (used.has(normalize(label))) label = base + ' (' + ++option + ')';
      labels.set(id, label);
      used.add(normalize(label));
    }
    return labels;
  }

  async function profileLabel(id) {
    const rows = await data.roster();
    return friendlyNames(rows).get(id);
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function disclosure(label) {
    const details = element('details');
    details.append(element('summary', label));
    return details;
  }

  function ask(title, description, label, danger = false) {
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('p').textContent = description;
    const yes = dialog.querySelector('[value="sim"]');
    yes.textContent = label;
    yes.classList.toggle('aluno-danger', danger);
    dialog.returnValue = '';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'sim'), {once: true});
      dialog.showModal();
    });
  }

  function progressText(activity) {
    const n = activity.items.filter(item => item.choice !== null).length;
    const total = activity.items.length;
    const chapters = new Set(activity.questions.map(q => q.capitulo));
    const mission = total === 16 && chapters.size === 1 ? 'Missão Atos ' + [...chapters][0] :
      ({5: 'Desafio rápido', 10: 'Individual', 20: 'Grande missão',
        40: 'Super missão', 80: 'Maratona'}[total] || 'Missão');
    return mission + ' · ' + (activity.mode === 'desafio' ? 'Desafio' : 'Estudo') +
      ' · ' + n + '/' + total + ' perguntas respondidas (' + Math.round(100 * n / total) + '%)';
  }

  async function activate(profile) {
    const label = await profileLabel(profile.id);
    if (!label) throw new data.Conflict('O perfil já foi removido deste navegador.');
    identification = await data.identity(profile.id);
    activeLabel = label;
    enter(profile);
  }

  function nameField(value = '') {
    const label = element('label', 'Nome ou apelido (opcional)');
    const input = element('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.maxLength = 120;
    input.value = value;
    label.append(input);
    return {label, input};
  }

  function importControls(parent) {
    const restore = disclosure('Restaurar progresso');
    const file = element('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.id = 'aluno-import-file';
    file.className = 'aluno-file';
    const label = element('label', 'Selecionar arquivo JSON', 'aluno-file-label');
    label.htmlFor = file.id;
    const filename = element('p', 'Nenhum arquivo selecionado.', 'muted');
    filename.setAttribute('aria-live', 'polite');
    file.addEventListener('change', () => {
      filename.textContent = file.files[0]?.name || 'Nenhum arquivo selecionado.';
    });
    restore.append(file, label, filename, button('Conferir e restaurar arquivo', async () => {
      const chosen = file.files[0];
      if (!chosen || chosen.size > data.maxBytes) {
        message('Escolha um arquivo JSON de até 32 MiB.');
        return;
      }
      let profile;
      try {
        profile = await data.decode(await chosen.text(), bankVersion, byId);
      } catch (error) {
        technicalError(error);
        message('Arquivo inválido, corrompido ou incompatível com esta versão.');
        return;
      }
      const label = await profileLabel(profile.id);
      const summary = [label || 'Novo perfil neste navegador', countMissions(profile.history.length),
        profile.active ? progressText(profile.active) : 'Sem atividade em andamento.',
        'A cópia será guardada neste navegador. Se já houver dados diferentes para este perfil, a restauração será cancelada.'
      ].join('\n');
      if (!await ask('Conferir restauração', summary, 'Restaurar progresso')) return;
      await activate(await data.write(profile, null));
      message('Perfil restaurado.');
    }), element('p', 'Proteja os backups. Eles contêm dados individuais. O checksum detecta mudanças no arquivo e pode ser recalculado após uma alteração intencional.', 'muted'));
    parent.append(restore);
  }

  function technicalError(error) {
    diagnostic = error instanceof data.Conflict ? 'Conflito de revisão' : error.name || 'Erro';
    console.warn('EBD KOINONIA · dados locais', error);
  }

  async function download() {
    const profile = await data.get(selected.id);
    data.validate(profile, bankVersion, byId);
    const json = await data.encode(profile);
    const link = element('a');
    if (!('download' in link) || typeof URL.createObjectURL !== 'function') {
      message('O download direto não está disponível neste navegador.');
      return;
    }
    const url = URL.createObjectURL(new Blob([json], {type: 'application/json'}));
    link.href = url;
    link.download = 'ebd-koinonia-progresso-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    try { link.click(); }
    finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    message('Download iniciado. Guarde a cópia em local privado.');
  }

  async function panel(switching = false) {
    const section = element('section', undefined, 'aluno-panel');
    const title = element('h2', selected && !switching ? 'Meu perfil' : 'Modo acompanhado');
    title.tabIndex = -1;
    section.append(title);
    if (selected && !switching) {
      section.append(element('h3', activeLabel),
        element('p', countMissions(selected.history.length)));
      if (active) {
        const resumeButton = button('Retomar atividade', () => {
          profilePanel = false;
          original.resume();
        });
        resumeButton.className = 'primary';
        section.append(element('p', progressText(active)), resumeButton);
      }
      section.append(button('Continuar atividade', () => {
        profilePanel = false;
        original.home();
      }), button('Meu desempenho', () => {
        profilePanel = false;
        original.stats();
      }), button('Trocar de perfil', () => panel(true)));

      const edit = disclosure('Editar identificação');
      const field = nameField(identification);
      edit.append(field.label, button('Salvar identificação', async () => {
        const saved = await data.rename(selected.id, selected.rev, field.input.value);
        selected.rev = saved.rev;
        identification = saved.name;
        activeLabel = await profileLabel(selected.id) || identification || 'Perfil';
        modeLabel();
        await panel();
        message('Identificação atualizada.');
      }));
      section.append(edit);

      const management = disclosure('Gerenciar meus dados');
      const preference = element('label', undefined, 'aluno-check');
      const check = element('input');
      check.type = 'checkbox';
      check.checked = remembered() === selected.id;
      preference.append(check, document.createTextNode('Lembrar meu perfil neste dispositivo'));
      check.addEventListener('change', () => {
        try {
          remember(check.checked ? selected.id : null);
          message(check.checked ? 'Perfil lembrado neste dispositivo.' : 'Memorização desativada.');
        } catch (error) {
          technicalError(error);
          check.checked = remembered() === selected.id;
          message('Não foi possível atualizar a memorização.');
        }
      });
      management.append(preference, element('p',
        'Esta identificação local não é autenticação segura. Evite lembrar o perfil em dispositivos compartilhados.', 'muted'),
        button('Salvar cópia de segurança', download));
      importControls(management);
      const technical = disclosure('Detalhes técnicos');
      technical.append(element('p', 'Código interno do perfil'), element('code', selected.id));
      const technicalId = selected.id;
      technical.addEventListener('toggle', () => {
        if (!technical.open || technical.querySelector('.aluno-queue')) return;
        const queue = element('p', 'Consultando fila local…', 'aluno-queue');
        technical.append(queue);
        data.queueReferences(technicalId).then(rows => {
          queue.textContent = 'Registros na fila local: ' + rows.length;
        }).catch(error => {
          technicalError(error);
          queue.textContent = 'Fila local indisponível.';
        });
      });
      if (diagnostic) technical.append(element('p', 'Último diagnóstico: ' + diagnostic));
      management.append(technical);
      const remove = button('Excluir perfil', async () => {
        const warning = 'Serão excluídos deste navegador a identificação, o consentimento, a atividade em andamento, o histórico e a fila local de ' +
          activeLabel + '. Outros perfis e arquivos externos serão preservados. Para guardar os dados, cancele e salve uma cópia de segurança.';
        if (!await ask('Excluir perfil e progresso?', warning, 'Excluir perfil', true)) return;
        await data.remove(selected.id, selected.rev);
        leave(remembered() === selected.id);
        await panel();
        message('Perfil excluído deste navegador.');
      });
      remove.className = 'aluno-danger';
      management.append(remove);
      section.append(management);
    } else {
      if (selected) section.append(button('Voltar ao meu perfil', () => panel()));
      const list = element('div', undefined, 'aluno-profile-list');
      section.append(list);
      const enrollment = disclosure('Criar perfil');
      const field = nameField();
      const consent = element('p',
        'Para guardar e retomar seu progresso, este navegador armazena identificação local, consentimento, respostas, consultas, tempo e resultados. Os dados ficam neste dispositivo, sem sincronização remota. Quem usa o mesmo navegador pode acessar os perfis. Você pode baixar uma cópia ou excluir os dados. Qualquer sincronização futura exigirá autorização separada.');
      enrollment.append(consent, field.label, button('Aceito guardar meu progresso e criar perfil', async () => {
        const profile = await data.write(data.createProfile(), null, field.input.value);
        await activate(profile);
      }));
      section.append(enrollment);
      importControls(section);
      profilePanel = true;
      view.replaceChildren(section);
      const previous = remembered();
      const rows = await data.roster();
      if (previous && !rows.some(row => row.id === previous) && remembered() === previous) {
        try { remember(null); } catch (error) { technicalError(error); }
      }
      const labels = friendlyNames(rows);
      rows.sort((a, b) => Number(b.id === previous) - Number(a.id === previous) ||
        a.number - b.number);
      for (const {id} of rows) {
        if (id === selected?.id) continue;
        list.append(button('Abrir ' + labels.get(id) + (id === previous ? ' · lembrado' : ''),
          () => activateFromList(id)));
      }
    }
    section.append(button('Voltar ao modo livre', () => leave()));
    profilePanel = true;
    if (!section.isConnected) view.replaceChildren(section);
  }

  async function activateFromList(id) {
    const profile = await data.get(id);
    if (!profile) {
      await panel(Boolean(selected));
      message('O perfil já foi removido deste navegador.');
      return;
    }
    await activate(profile);
  }

  change.addEventListener('click', () => operation(async () => {
    if (profilePanel) {
      profilePanel = false;
      original.home();
      return;
    }
    stopViewing();
    if (selected && active && active.elapsed !== savedElapsed) await save();
    else if (draining) await draining;
    if (!failure) await panel();
  }));

  retry.addEventListener('click', async () => {
    failure = null;
    busy = true;
    locking();
    try {
      await drain();
      if (!failure) {
        message('Progresso salvo.');
        if (active) original.resume();
      }
    } finally {
      busy = false;
      locking();
    }
  });
  reopen.addEventListener('click', async () => {
    if (dialog.open || !await ask('Reabrir página?', 'As mudanças ainda pendentes nesta página serão descartadas.', 'Reabrir página', true)) return;
    failure = null;
    pending = null;
    location.reload();
  });
  recovery.hidden = false;
  modeLabel();
})();
