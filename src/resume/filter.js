/** All track ids used in bullet tags across the model, sorted. */
export function knownTracks(model) {
  const set = new Set();
  for (const s of model.sections) {
    for (const b of s.bullets) b.tracks?.forEach((t) => set.add(t));
    for (const e of s.entries) for (const b of e.bullets) b.tracks?.forEach((t) => set.add(t));
  }
  return [...set].sort();
}

/**
 * Keep untagged bullets always; keep tagged bullets only when they include `track`.
 * Without a track, every bullet is kept. Returns a new model; input is not mutated.
 * Warns (stderr by default) when `track` appears in no bullet tag.
 * @param {object} model parsed resume model
 * @param {string} [track]
 * @param {{warn?: (msg: string) => void}} [opts]
 */
export function filterByTrack(model, track, { warn = (m) => process.stderr.write(`warning: ${m}\n`) } = {}) {
  if (!track) return model;
  const id = String(track).toLowerCase();
  const known = knownTracks(model);
  if (!known.includes(id)) warn(`track '${id}' not found in any bullet tags; known: ${known.join(', ') || '(none)'}`);
  const keep = (bullets = []) => bullets.filter((b) => !b.tracks?.length || b.tracks.includes(id));
  return {
    ...model,
    sections: model.sections.map((s) => ({
      ...s,
      bullets: keep(s.bullets),
      entries: s.entries.map((e) => ({ ...e, bullets: keep(e.bullets) })),
    })),
  };
}
