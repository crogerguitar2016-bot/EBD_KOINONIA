'use strict';

globalThis.EBDAlunoDados = (() => {
  const version = 2;
  const terms = 1;
  const maxAttempts = 200;
  const maxBytes = 32 * 1024 * 1024;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const sha = /^[0-9a-f]{64}$/;
  const missionSizes = [5, 10, 16, 20, 40, 80];
  const questionStrings = [
    'id', 'titulo', 'pergunta', 'referenciaBiblica', 'pista', 'explicacao', 'categoria', 'dificuldade'
  ];
  const date = value => typeof value === 'string' && value.length === 24 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const str = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const keys = (value, expected) => value !== null && typeof value === 'object' &&
    !Array.isArray(value) && Object.keys(value).length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key));

  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  async function digest(value) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function requireValid(condition) {
    if (!condition) throw new Error('Dados incompatíveis ou inconsistentes.');
  }

  function questionValid(q) {
    return keys(q, [...questionStrings, 'capitulo', 'alternativas', 'indiceRespostaCorreta']) &&
      questionStrings.every(field => str(q[field], field === 'id' ? 80 : 4000)) &&
      int(q.capitulo, 8, 12) && ['Fácil', 'Intermediária', 'Avançada'].includes(q.dificuldade) &&
      Array.isArray(q.alternativas) && int(q.alternativas.length, 2, 12) &&
      q.alternativas.every(option => str(option, 2000)) &&
      int(q.indiceRespostaCorreta, 0, q.alternativas.length - 1);
  }

  function attemptValid(attempt, owner, currentBank, questions, finished) {
    if (!keys(attempt, [
      'id', 'owner', 'bankVersion', 'mode', 'elapsed', 'index', 'items', 'questions', 'finished'
    ]) || !str(attempt.id, 36) || !uuid.test(attempt.id) || attempt.owner !== owner ||
      !str(attempt.bankVersion, 64) || !sha.test(attempt.bankVersion) ||
      !['estudo', 'desafio'].includes(attempt.mode) ||
      !int(attempt.elapsed, 0, Number.MAX_SAFE_INTEGER) ||
      (finished ? !date(attempt.finished) : attempt.finished !== null) ||
      !Array.isArray(attempt.items) || !missionSizes.includes(attempt.items.length) ||
      !Array.isArray(attempt.questions) || attempt.questions.length !== attempt.items.length ||
      !int(attempt.index, 0, attempt.items.length - 1) ||
      (finished && attempt.index !== attempt.items.length - 1)) return false;

    const seen = new Set();
    return attempt.items.every((item, index) => {
      const q = attempt.questions[index];
      if (!keys(item, ['id', 'order', 'choice', 'hint', 'consults', 'assistedConsults']) ||
        !questionValid(q) || q.id !== item.id || seen.has(item.id) ||
        (attempt.bankVersion === currentBank && canonical(q) !== canonical(questions.get(q.id))) ||
        !Array.isArray(item.order) || item.order.length !== q.alternativas.length ||
        new Set(item.order).size !== item.order.length ||
        !item.order.every(option => int(option, 0, item.order.length - 1)) ||
        (item.choice !== null && !int(item.choice, 0, item.order.length - 1)) ||
        typeof item.hint !== 'boolean' || !int(item.consults, 0, Number.MAX_SAFE_INTEGER) ||
        !int(item.assistedConsults, 0, item.consults) ||
        (attempt.mode === 'desafio' && (item.hint || item.assistedConsults)) ||
        (item.choice === null && item.consults !== item.assistedConsults) ||
        ((finished || index < attempt.index) && item.choice === null) ||
        (index > attempt.index && (item.choice !== null || item.hint || item.consults))) return false;
      seen.add(item.id);
      return true;
    });
  }

  function validate(profile, currentBank, questions) {
    requireValid(keys(profile, ['id', 'rev', 'consent', 'active', 'history']) &&
      str(profile.id, 36) && uuid.test(profile.id) && int(profile.rev, 0, Number.MAX_SAFE_INTEGER) &&
      keys(profile.consent, ['version', 'local', 'future', 'date']) &&
      profile.consent.version === terms && profile.consent.local === 'accepted' &&
      profile.consent.future === 'pending' && date(profile.consent.date) &&
      Array.isArray(profile.history) && profile.history.length <= maxAttempts);
    const ids = new Set();
    for (const attempt of profile.history) {
      requireValid(attemptValid(attempt, profile.id, currentBank, questions, true) &&
        !ids.has(attempt.id));
      ids.add(attempt.id);
    }
    if (profile.active !== null) {
      requireValid(profile.history.length < maxAttempts &&
        attemptValid(profile.active, profile.id, currentBank, questions, false) &&
        !ids.has(profile.active.id));
    }
    return profile;
  }

  function createProfile() {
    return {
      id: crypto.randomUUID(), rev: 0,
      consent: {version: terms, local: 'accepted', future: 'pending', date: new Date().toISOString()},
      active: null, history: []
    };
  }

  async function encode(profile) {
    const data = {format: 'ebd-koinonia-aluno', version: 1, profile: {...profile, rev: 0}};
    const out = JSON.stringify({...data, checksum: await digest(canonical(data))});
    requireValid(new TextEncoder().encode(out).length <= maxBytes);
    return out;
  }

  async function decode(text, currentBank, questions) {
    requireValid(new TextEncoder().encode(text).length <= maxBytes);
    const value = JSON.parse(text);
    requireValid(keys(value, ['format', 'version', 'profile', 'checksum']) &&
      value.format === 'ebd-koinonia-aluno' && value.version === 1 &&
      str(value.checksum, 64) && sha.test(value.checksum));
    const {checksum, ...data} = value;
    requireValid(await digest(canonical(data)) === checksum);
    requireValid(value.profile?.rev === 0);
    return validate(value.profile, currentBank, questions);
  }

  const dbName = `ebd-koinonia-aluno:${new URL('.', globalThis.location?.href ??
    'http://localhost/index.html').pathname}`;
  let opening;

  function queueRow(profile, attempt) {
    return {
      id: `${profile.id}:${attempt.id}`, profileId: profile.id, attemptId: attempt.id,
      schema: 1, state: 'awaiting-consent-and-integration', createdAt: attempt.finished
    };
  }

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, version);
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        opening = undefined;
        reject(new Error('Feche as outras páginas da EBD e tente novamente.'));
      };
      request.onupgradeneeded = event => {
        const db = request.result;
        try {
          if (event.oldVersion < 1) db.createObjectStore('profiles', {keyPath: 'id'});
          if (event.oldVersion < 2) {
            const queue = db.createObjectStore('queue', {keyPath: 'id'});
            queue.createIndex('profileId', 'profileId');
            const cursor = request.transaction.objectStore('profiles').openCursor();
            cursor.onsuccess = () => {
              const entry = cursor.result;
              if (!entry) return;
              try {
                for (const attempt of entry.value.history) queue.add(queueRow(entry.value, attempt));
                entry.continue();
              } catch {
                request.transaction.abort();
              }
            };
          }
        } catch {
          request.transaction.abort();
        }
      };
      request.onerror = () => {
        if (blocked) return;
        opening = undefined;
        reject(request.error);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = db.onclose = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    });
    return opening;
  }

  async function transaction(names, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = mode === 'readwrite'
        ? db.transaction(names, mode, {durability: 'strict'}) : db.transaction(names, mode);
      let result;
      let failure;
      const guard = callback => event => {
        try {
          callback(event.target.result);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('Gravação cancelada.'));
      try {
        work(tx, guard, value => { result = value; });
      } catch (error) {
        failure = error;
        tx.abort();
      }
    });
  }

  function keysList() {
    return transaction(['profiles'], 'readonly', (tx, guard, result) => {
      tx.objectStore('profiles').getAllKeys().onsuccess = guard(ids => result(ids.filter(id => typeof id === 'string' && uuid.test(id))));
    });
  }

  function get(id) {
    return transaction(['profiles'], 'readonly', (tx, guard, result) => {
      tx.objectStore('profiles').get(id).onsuccess = guard(result);
    });
  }

  class Conflict extends Error {}

  // Os perfis e backups originais mantêm seu formato. A identificação opcional
  // fica no mesmo armazenamento, fora da chave e do registro pedagógico.
  const identityKey = id => 'identificacao:' + id;

  // Numeração local dos perfis, fora do registro pedagógico e do JSON v1.
  const rosterKey = 'apresentacao:perfis';

  function roster() {
    return transaction(['profiles'], 'readwrite', (tx, guard, result) => {
      const store = tx.objectStore('profiles');
      store.getAllKeys().onsuccess = guard(keys => {
        const ids = keys.filter(id => typeof id === 'string' && uuid.test(id));
        if (!ids.length) return result([]);
        store.get(rosterKey).onsuccess = guard(saved => {
          const numbers = new Map(saved?.entries || []);
          let last = saved?.last || 0;
          const entries = ids.map(id => {
            if (!numbers.has(id)) {
              if (!Number.isSafeInteger(last + 1)) throw new Error('Numeração local esgotada.');
              numbers.set(id, ++last);
            }
            return [id, numbers.get(id)];
          });
          if (last !== saved?.last || entries.length !== saved.entries.length) {
            store.put({id: rosterKey, last, entries});
          }
          const rows = [];
          for (const [id, number] of entries) {
            store.get(identityKey(id)).onsuccess = guard(identity => {
              rows.push({id, number, name: identity?.name || ''});
              if (rows.length === entries.length) result(rows);
            });
          }
        });
      });
    });
  }

  function normalizeName(value) {
    return Array.from(value.normalize('NFC')
      .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069\u200e\u200f]/gu, '')
      .trim().replace(/\s+/gu, ' ')).slice(0, 60).join('');
  }

  function identity(id) {
    return transaction(['profiles'], 'readonly', (tx, guard, result) => {
      const store = tx.objectStore('profiles');
      store.get(id).onsuccess = guard(profile => {
        if (!profile) return result('');
        store.get(identityKey(id)).onsuccess = guard(row => result(row?.name || ''));
      });
    });
  }

  // Interface local de leitura para futura integração, sem destino de rede.
  function queueReferences(id) {
    return transaction(['queue'], 'readonly', (tx, guard, result) => {
      tx.objectStore('queue').index('profileId').getAll(IDBKeyRange.only(id)).onsuccess = guard(result);
    });
  }

  function rename(id, expected, value) {
    const name = normalizeName(value);
    return transaction(['profiles'], 'readwrite', (tx, guard, result) => {
      const store = tx.objectStore('profiles');
      store.get(id).onsuccess = guard(profile => {
        if (!profile || profile.rev !== expected) throw new Conflict('O perfil mudou em outra página.');
        if (name) store.put({id: identityKey(id), name});
        else store.delete(identityKey(id));
        store.put({...profile, rev: expected + 1});
        result({name, rev: expected + 1});
      });
    });
  }



  function classRows() {
    return transaction(['queue'], 'readonly', (tx, guard, result) => {
      tx.objectStore('queue').getAll().onsuccess = guard(rows =>
        result(rows.filter(row => row.classState)));
    });
  }

  function classClaim(id, lease, now, manual) {
    return transaction(['queue'], 'readwrite', (tx, guard, result) => {
      const queue = tx.objectStore('queue');
      queue.get(id).onsuccess = guard(row => {
        if (row?.classState !== 'pending' || row.leaseUntil > now ||
          (!manual && row.nextAt > now)) return result(false);
        queue.put({...row, lease, leaseUntil: now + 120000});
        result(true);
      });
    });
  }

  function classSettle(id, lease, patch) {
    return transaction(['queue'], 'readwrite', (tx, guard) => {
      const queue = tx.objectStore('queue');
      queue.get(id).onsuccess = guard(row => {
        if (row?.lease !== lease || row.classState !== 'pending') return;
        const {lease: held, leaseUntil, ...retained} = row;
        if (patch.classState !== 'pending') delete retained.payload;
        queue.put({...retained, ...patch});
      });
    });
  }

  function classCancel(project, uid, c) {
    return transaction(['queue'], 'readwrite', (tx, guard) => {
      const request = tx.objectStore('queue').openCursor();
      request.onsuccess = guard(cursor => {
        if (!cursor) return;
        const row = cursor.value;
        const binding = row.binding;
        if (binding?.project === project && binding.uid === uid && binding.c === c &&
          row.classState !== 'sent') {
          if (row.classState === 'started') cursor.delete();
          else {
            const {payload, lease, leaseUntil, ...retained} = row;
            cursor.update({...retained, classState: 'blocked', reason: 'revogacao'});
          }
        }
        cursor.continue();
      });
    });
  }

  function write(profile, expected, initialName = '', classroom) {
    return transaction(['profiles', 'queue'], 'readwrite', (tx, guard, result) => {
      const profiles = tx.objectStore('profiles');
      const queue = tx.objectStore('queue');
      profiles.get(profile.id).onsuccess = guard(existing => {
        if (expected === null && existing) {
          if (canonical({...existing, rev: 0}) === canonical({...profile, rev: 0})) {
            result(existing);
            return;
          }
          throw new Conflict('Já existe um perfil diferente com este identificador. Restauração cancelada.');
        }
        if (expected !== null && (!existing || existing.rev !== expected)) {
          throw new Conflict('O perfil mudou em outra página. Reabra o perfil para recuperar a última gravação.');
        }
        const saved = {...profile, rev: expected === null ? 0 : expected + 1};
        profiles.put(saved);
        if (expected === null) {
          const name = normalizeName(initialName);
          if (name) profiles.put({id: identityKey(saved.id), name});
          else profiles.delete(identityKey(saved.id));
        }
        if (existing?.active && existing.active.id !== saved.active?.id &&
            !saved.history.some(attempt => attempt.id === existing.active.id)) {
          queue.delete(`${saved.id}:${existing.active.id}:turma`);
        }
        if (existing && saved.active && saved.active.id !== existing.active?.id &&
            classroom?.started?.id === saved.active.id && classroom.started.binding.profile === saved.id) {
          const {id: attemptId, binding} = classroom.started;
          queue.add({id: `${saved.id}:${attemptId}:turma`, profileId: saved.id, attemptId,
            binding, classState: 'started'});
        }
        const previous = new Set(existing?.history.map(attempt => attempt.id));
        for (const attempt of saved.history) {
          if (previous.has(attempt.id)) continue;
          queue.add(queueRow(saved, attempt));
          if (existing?.active?.id !== attempt.id || classroom?.finished?.id !== attempt.id) continue;
          const key = `${saved.id}:${attempt.id}:turma`;
          queue.get(key).onsuccess = guard(row => {
            if (row?.classState !== 'started') return;
            if (Date.now() >= row.binding.until) {
              queue.delete(key);
              return;
            }
            queue.put({...row, payload: classroom.finished.payload, classState: 'pending',
              tries: 0, nextAt: 0});
          });
        }
        result(saved);
      });
    });
  }

  function remove(id, expected) {
    return transaction(['profiles', 'queue'], 'readwrite', (tx, guard) => {
      const profiles = tx.objectStore('profiles');
      const queue = tx.objectStore('queue');
      profiles.get(id).onsuccess = guard(profile => {
        if (!profile || profile.rev !== expected) {
          throw new Conflict('O perfil mudou. Reabra o perfil antes de excluir.');
        }
        profiles.delete(id);
        profiles.delete(identityKey(id));
        profiles.get(rosterKey).onsuccess = guard(saved => {
          if (!saved) return;
          profiles.put({...saved, entries: saved.entries.filter(([profileId]) => profileId !== id)});
        });
        const cursor = queue.index('profileId').openCursor(IDBKeyRange.only(id));
        cursor.onsuccess = guard(entry => {
          if (!entry) return;
          entry.delete();
          entry.continue();
        });
      });
    });
  }

  return {dbName, maxAttempts, maxBytes, createProfile, encode, decode, validate,
    keysList, get, write, remove, identity, roster, rename, normalizeName, queueReferences,
    classRows, classClaim, classSettle, classCancel, Conflict};
})();
