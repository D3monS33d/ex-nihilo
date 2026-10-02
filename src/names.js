// Names for things nobody named: species get a pronounceable label from their key,
// and new universes get a readable seed.

const SYLLABLES = [
  'ka', 'ri', 'to', 've', 'lu', 'mi', 'so', 'na', 'xe', 'qui', 'zi', 'ba', 'do', 'fe', 'gu', 'hy',
  'jo', 'ky', 'le', 'mo', 'nu', 'pa', 'ra', 'si', 'ty', 'vo', 'wa', 'xi', 'yu', 'ze', 'an', 'or',
];

export function speciesName(key) {
  let k = Math.floor(key / 4096);
  let name = '';
  for (let i = 0; i < 3; i++) {
    name += SYLLABLES[k % 32];
    k = Math.floor(k / 32);
  }
  return name[0].toUpperCase() + name.slice(1);
}

const ADJECTIVES = [
  'amber', 'silent', 'hollow', 'bright', 'feral', 'patient', 'restless', 'pale', 'molten', 'quiet',
  'hungry', 'distant', 'broken', 'gentle', 'salted', 'velvet', 'copper', 'frozen', 'wild', 'lucid',
];
const NOUNS = [
  'void', 'tide', 'ember', 'garden', 'static', 'ocean', 'spark', 'mirror', 'dust', 'signal',
  'marsh', 'engine', 'lattice', 'storm', 'cradle', 'echo', 'kiln', 'reef', 'orbit', 'seed',
];

export function randomSeed() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(Math.random() * 900 + 100)}`;
}
