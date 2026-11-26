'use strict';
(() => {
  const chapters = [8, 9, 10, 11, 12];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const scope = /^[A-Za-z0-9_-]{1,80}$/;

  function summarize(attempt, result) {
    const row = {versao: 1, pontuacao: 1, banco: attempt.bankVersion,
      modo: result.mode, total: result.total, atividade: String(result.total), verificado: false};
    for (const chapter of chapters) row['c' + chapter] = {n: 0, a: 0, p: 0};
    for (const answer of result.answers) {
      const bucket = row['c' + answer.chapter];
      bucket.n++;
      bucket.a += Number(answer.correct);
      bucket.p += answer.points;
    }
    if (row.total === 16) row.atividade = 'atos-' + result.answers[0].chapter;
    return row;
  }

  function canonical(value) {
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(key =>
        JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  async function digest(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function stats(row) {
    return chapters.reduce((sum, chapter) => {
      const {n, a, p} = row['c' + chapter];
      return {n: sum.n + n, a: sum.a + a, p: sum.p + p};
    }, {n: 0, a: 0, p: 0});
  }

  function csv(rows) {
    const cell = value => {
      let text = String(value ?? '');
      if (typeof value === 'string' &&
        (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  globalThis.EBDTurmaCore = Object.freeze({chapters, uuid, scope, summarize, digest, stats, csv});
})();
