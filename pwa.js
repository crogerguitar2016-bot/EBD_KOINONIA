'use strict';

(() => {
  const script = document.currentScript;
  if (!script || !window.isSecureContext || !navigator.serviceWorker) return;
  if (location.protocol !== 'https:' && !(
    location.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  )) return;

  const scope = new URL('./', script.src);
  if (scope.origin !== location.origin || !location.pathname.startsWith(scope.pathname)) return;
  const worker = new URL('sw.js', scope);
  const service = navigator.serviceWorker;
  const display = window.matchMedia('(display-mode: standalone)');
  const ios = /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(navigator.userAgent);
  const observed = new WeakSet();
  let registration;
  let installEvent;
  let installingFromPrompt = false;
  let installedHere = false;

  const controls = document.createElement('details');
  controls.style.cssText = 'max-width:42rem;margin:1rem auto;padding:0 1rem;font-size:.875rem';
  const title = document.createElement('summary');
  title.textContent = 'Aplicativo e acesso offline';
  const offline = document.createElement('p');
  const update = document.createElement('small');
  update.setAttribute('role', 'status');
  update.hidden = true;
  update.style.cssText = 'display:block;max-width:42rem;margin:.5rem auto;padding:0 1rem';
  // O atributo hidden precisa continuar prevalecendo sobre outros estilos.
  update.style.removeProperty('display');

  const instructions = document.createElement('p');
  const install = document.createElement('button');
  install.type = 'button';
  install.textContent = 'Instalar aplicativo';
  install.style.cssText = 'width:auto';
  install.hidden = true;

  controls.append(title, offline, instructions, install);
  document.body.append(controls, update);

  const isOurs = candidate => candidate && candidate.scriptURL === worker.href;
  const standalone = () => installedHere || display.matches || navigator.standalone === true;

  function render() {
    const controller = service.controller;
    const available = isOurs(controller) && controller.state === 'activated';
    offline.textContent = available
      ? 'Acesso offline disponível para as páginas e os conteúdos locais da EBD.'
      : 'O acesso offline ficará disponível quando o aplicativo controlar esta página. Se necessário, volte em uma próxima visita.';
    const waiting = registration && registration.waiting;
    update.hidden = !(isOurs(waiting) && waiting.state === 'installed');
    update.textContent = update.hidden ? '' :
      'Atualização pronta. Ela será aplicada depois que todas as páginas da EBD forem fechadas, sem interromper sua atividade.';
    install.hidden = standalone() || !installEvent || installingFromPrompt;
    instructions.hidden = standalone() || !!installEvent;
    instructions.textContent = ios
      ? 'No Safari, abra Compartilhar e selecione “Adicionar à Tela de Início”.'
      : android
        ? 'No Android, abra o menu do navegador e procure “Instalar aplicativo” ou “Adicionar à tela inicial”.'
        : 'No computador, procure “Instalar aplicativo” no menu ou na barra de endereços. No Safari para Mac, procure “Adicionar ao Dock” no menu Arquivo. Se a opção não aparecer, use a EBD pela aba do navegador.';
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    if (!standalone()) installEvent = event;
    render();
  });

  window.addEventListener('appinstalled', () => {
    installedHere = true;
    installEvent = undefined;
    render();
  });

  display.addEventListener?.('change', render);

  install.addEventListener('click', async () => {
    if (!installEvent || installingFromPrompt || standalone()) return;
    const prompt = installEvent;
    installEvent = undefined;
    installingFromPrompt = true;
    try {
      await prompt.prompt();
      if ((await prompt.userChoice)?.outcome === 'accepted') installedHere = true;
    } catch {
      // As instruções do navegador continuam disponíveis.
    } finally {
      installingFromPrompt = false;
      render();
    }
  });

  function observe(candidate) {
    if (!isOurs(candidate) || observed.has(candidate)) return;
    observed.add(candidate);
    candidate.addEventListener('statechange', () => {
      render();
      // Aguarda a atualização de registration.waiting após a transição.
      setTimeout(render, 0);
    });
  }

  function sync() {
    observe(service.controller);
    if (registration) {
      observe(registration.installing);
      observe(registration.waiting);
      observe(registration.active);
    }
    render();
  }

  service.addEventListener('controllerchange', sync);
  window.addEventListener('pageshow', sync);
  sync();

  (async () => {
    try {
      const result = await service.register(worker.href, {
        scope: scope.href,
        updateViaCache: 'none',
      });
      if (result.scope !== scope.href) return;
      registration = result;
      registration.addEventListener('updatefound', sync);
      sync();
    } catch {
      offline.textContent = 'Não foi possível preparar o acesso offline nesta visita.';
    }
  })();
})();
