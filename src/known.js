// Universes whose history has been charted with the multiverse lab (lab.html).
// Because everything is deterministic, these epochs are the same on every machine.
// They were the four universes, out of the sixty numbered 1 to 60, in which life
// appeared within 16,000 epochs. Most universes take far longer.
//
// life: epoch of the first birth. takeover: epoch at which life held half the cells.
// The first entry is the default universe.

export const KNOWN_UNIVERSES = [
  { seed: '25', life: 12736, takeover: 14080 },
  { seed: '39', life: 10864, takeover: 21440 },
  { seed: '58', life: 14528, takeover: 21184 },
  // Two attempts, both extinct; still lifeless at epoch 68,208, where the charting stopped.
  { seed: '21', life: 8208, takeover: null, note: 'dies out, twice' },
];
