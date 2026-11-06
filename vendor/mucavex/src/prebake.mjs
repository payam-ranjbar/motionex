// Mirror of @strudel/repl's prebake (strudel.cc / <strudel-editor>), so code that
// plays in the browser REPL renders the same here: same sample banks, drum-machine
// aliases, GM soundfonts and the .piano() helper.
//
// Sample maps are just JSON indexes (audio loads lazily on first use), and all
// fetches go through the disk cache in fetch.mjs, so this is cheap after first boot.
import { Pattern, noteToMidi, valueToMidi } from '@strudel/core';
import { aliasBank, samples } from 'superdough';

const ds = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const ts = 'https://raw.githubusercontent.com/todepond/samples/main';
const tc = 'https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main';

export const STRUDEL_SAMPLE_MAPS = [
  `${ds}/tidal-drum-machines.json`,
  `${ds}/piano.json`,
  `${ds}/Dirt-Samples.json`,
  `${ds}/vcsl.json`,
  `${ds}/mridangam.json`,
  `${tc}/strudel.json`,
];
const STRUDEL_ALIASES = `${ts}/tidal-drum-machines-alias.json`;

const warn = (what) => (err) => console.warn(`[prebake] ${what}: ${err.message}`);

export async function prebake({ strudelDefaults = true, extraSampleMaps = [] } = {}) {
  definePiano();
  defineVisualNoops();
  const jobs = extraSampleMaps.map((map) => samples(map).catch(warn(`samples ${map}`)));
  if (strudelDefaults) {
    jobs.push(
      import('@strudel/soundfonts').then(({ registerSoundfonts }) => registerSoundfonts()).catch(warn('soundfonts')),
      ...STRUDEL_SAMPLE_MAPS.map((map) => samples(map).catch(warn(`samples ${map}`))),
    );
  }
  await Promise.all(jobs);
  if (strudelDefaults) await aliasBank(STRUDEL_ALIASES).catch(warn('drum machine aliases'));
}

function definePiano() {
  const maxPan = noteToMidi('C8');
  const panwidth = (pan, width) => pan * width + (1 - width) / 2;
  Pattern.prototype.piano = function () {
    return this.fmap((v) => ({ ...v, clip: v.clip ?? 1 }))
      .s('piano')
      .release(0.1)
      .fmap((value) => {
        const midi = valueToMidi(value);
        const pan = panwidth(Math.min(Math.round(midi) / maxPan, 1), 0.5);
        return { ...value, pan: (value.pan || 1) * pan };
      });
  };
}

// Visualisations (pianoroll, scope, hydra, ...) are common in REPL code but have
// nothing to draw on here. Make them pass the pattern through unchanged.
const VISUALS = ['pianoroll', 'punchcard', 'wordfall', 'scope', 'tscope', 'fscope', 'spectrum', 'spiral', 'pitchwheel', 'markcss'];
function defineVisualNoops() {
  for (const name of VISUALS) {
    for (const method of [name, `_${name}`]) {
      if (typeof Pattern.prototype[method] !== 'function') Pattern.prototype[method] = function () { return this; };
    }
  }
  for (const fn of ['initHydra', 'H', 'samples_hydra']) {
    globalThis[fn] ??= () => {};
  }
}
