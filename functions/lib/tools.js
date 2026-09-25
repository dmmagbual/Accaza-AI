"use strict";
// Combines tool sets (skills, web search, connectors) into one {declarations, run, label} for the
// provider tool loop. Each set: {declarations, run(name, args, ctx), labels?: {name: args => text}}.
function combineTools(sets) {
  const active = sets.filter(set => set && set.declarations && set.declarations.length);
  if (!active.length) return null;
  const owner = new Map();
  active.forEach(set => set.declarations.forEach(d => { if (!owner.has(d.name)) owner.set(d.name, set); }));
  return {
    declarations: [...owner.keys()].map(name => owner.get(name).declarations.find(d => d.name === name)),
    run: (name, args, ctx) => { const set = owner.get(name); return set ? set.run(name, args, ctx) : Promise.resolve({error: `Unknown tool ${name}.`}); },
    label: (name, args) => { const set = owner.get(name), fn = set && set.labels && set.labels[name]; try { return fn ? fn(args || {}) : name.replace(/_/g, " "); } catch (_error) { return name; } },
  };
}
module.exports = {combineTools};
