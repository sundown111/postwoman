// Merges AI-agent changes into a workspace state without clobbering the user's concurrent edits.
// Used by the server (when the UI saves) and by the UI (when an agent changed something). Pure (browser + Node).
(function (root) {
  'use strict';
  const LISTS = { tab: 'tabs', group: 'groups', env: 'envs' };
  const MAX_SAMPLES = 500, MAX_RUNS = 8;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  // Fields that grow on both sides are unioned; anything else: the agent's value wins.
  function mergeField(field, local, remote) {
    if (field === 'samples') {
      const seen = new Map();
      for (const s of [].concat(local || [], remote || [])) if (s) seen.set(s.t + '|' + s.ms + '|' + s.status, s);
      return [...seen.values()].sort((a, b) => a.t - b.t).slice(-MAX_SAMPLES);
    }
    if (field === 'loadRuns') {
      const seen = new Map();
      for (const r of [].concat(remote || [], local || [])) if (r && r.id && !seen.has(r.id)) seen.set(r.id, r);
      return [...seen.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_RUNS);
    }
    return remote;
  }

  // items: [{ kind:'tab'|'group'|'env', id, deleted, fields:null|[names], data }]
  // Whole-entity updates keep object identity (the UI holds references to the open tab / env).
  function applyItems(state, items) {
    const touched = { whole: new Set(), fields: new Set(), deleted: new Set(), kinds: new Set() };
    for (const it of items || []) {
      const key = LISTS[it.kind];
      if (!key) continue;
      const list = state[key] = Array.isArray(state[key]) ? state[key] : [];
      const i = list.findIndex((x) => x && x.id === it.id);
      if (it.deleted) {
        if (i >= 0) { list.splice(i, 1); touched.deleted.add(it.id); touched.kinds.add(it.kind); }
        continue;
      }
      if (!it.data) continue;
      if (!it.fields) {
        const copy = clone(it.data);
        if (i >= 0) { const obj = list[i]; for (const k of Object.keys(obj)) delete obj[k]; Object.assign(obj, copy); }
        else list.push(copy);
        touched.whole.add(it.id);
      } else if (i >= 0) {
        for (const f of it.fields) list[i][f] = mergeField(f, list[i][f], clone(it.data[f]));
        touched.fields.add(it.id);
      } else continue; // field-only change to something the user removed: keep it removed
      touched.kinds.add(it.kind);
    }
    return touched;
  }

  const api = { applyItems, mergeField, LISTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sync = api;
})(typeof window !== 'undefined' ? window : globalThis);
