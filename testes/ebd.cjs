
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = process.argv[2];
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const bank = fs.readFileSync(path.join(root, 'questoes-v03.js'), 'utf8');
const atlas = fs.readFileSync(path.join(root, 'explorar.js'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inline.length, 1);

const nodes = new Map();
let atlasButton;
const observerCallbacks = [];
const elements = selector => {
  if (!nodes.has(selector)) {
    nodes.set(selector, {
      value: selector === '#atlas-chapter' ? '8' : '',
      innerHTML:'', disabled:false, open:false,
      focus(){}, showModal(){this.open=true;},
      addEventListener(event, callback){this[event] = callback;},
      querySelector: elements,
      querySelectorAll(){return [];},
      append(button){atlasButton = button;}
    });
  }
  return nodes.get(selector);
};
let now = 1000;
const context = vm.createContext({
  document:{
    querySelector:elements, addEventListener(){},
    createElement(){return {addEventListener(type, callback){this[type]=callback;}};}
  },
  window:{addEventListener(){}},
  performance:{now:() => now},
  setInterval(){}, confirm:() => true,
  MutationObserver: class {
    constructor(callback){observerCallbacks.push(callback);}
    observe(){}
  }
});
const run = code => vm.runInContext(code, context);
run(bank);
run(inline[0][1]);
run(atlas);
assert.equal(run('bank.length'), 80);
assert.equal(run('byId.size'), 80);
assert.equal(run('chapters.every(c => bank.filter(q => q.capitulo === c).length === 16)'), true);
for (const total of [5, 10, 16, 20, 40, 80]) {
  elements('#mode').value = 'estudo';
  run(total === 16 ? 'start(16, 12)' : `start(${total})`);
  assert.equal(run('active.items.length'), total);
  assert.equal(run('new Set(active.items.map(q => q.id)).size'), total);
  if (total === 16) assert.equal(run('active.items.every(q => byId.get(q.id).capitulo === 12)'), true);
  run('home()');
}
run('active = null; home()');
elements('#mode').value = 'desafio';
run('start(5)');
observerCallbacks.forEach(callback => callback());
assert.equal(elements('#nav-bible').disabled, true);
assert.equal(atlasButton.disabled, true);
const before = elements('#view').innerHTML;
atlasButton.click();
assert.equal(elements('#view').innerHTML, before);
run('bible()');
assert.equal(elements('#reader').open, false);
now += 3000;
run(`for (let i = 0; i < 5; i++) {
  const item = currentItem();
  answer(item.order.indexOf(byId.get(item.id).indiceRespostaCorreta));
  next();
}`);
assert.equal(run('completed.score'), 5);
assert.equal(run('completed.elapsed'), 3000);
assert.equal(run('completed.points === completed.answers.reduce((s, q) => s + 2 * weights[q.difficulty], 0)'), true);
assert.equal(run('records.length'), 1);
assert.match(run('shareText()'), /5 de 5/);
assert.match(elements('#view').innerHTML, /wa\.me/);
atlasButton.click();
assert.match(elements('#view').innerHTML, /Cronologia/);
for (const chapter of [8, 9, 10, 11, 12]) {
  elements('#atlas-chapter').value = String(chapter);
  elements('#atlas-chapter').change();
  const content = elements('#atlas-content').innerHTML;
  assert.match(content, new RegExp(`Mapa esquemático de Atos ${chapter}`));
  assert.match(content, /Desafio em família/);
  assert.match(content, /Referências complementares/);
  assert.match(content, /Personagens/);
}
run('home()');
elements('#mode').value = 'estudo';
run('start(5)');
atlasButton.click();
assert.equal(run('currentItem().assistedConsults'), 1);
assert.equal(run('inActivity'), false);
run('resume(); revealHint(); answer(currentItem().order.indexOf(byId.get(currentItem().id).indiceRespostaCorreta))');
assert.equal(run('resultOf(currentItem()).points === Math.round(weights[byId.get(currentItem().id).dificuldade] * 0.5)'), true);
console.log('Banco, modalidades, missões, consulta, mapas, pontuação, cronômetro e compartilhamento verificados.');
