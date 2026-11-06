// Make Node look enough like a browser for superdough / @strudel/webaudio.
// Must be imported before any @strudel/* or superdough module.
import * as webaudio from 'node-web-audio-api';
import { installFetch } from './fetch.mjs';

for (const [name, value] of Object.entries(webaudio)) {
  if (name !== 'default' && name !== 'mediaDevices') globalThis[name] = value;
}

// We only ever render offline, but superdough may lazily create a realtime
// AudioContext. In a container there is no sound device and that would crash
// with DeviceNotAvailable, so default every realtime context to a null sink.
globalThis.AudioContext = class extends webaudio.AudioContext {
  constructor(options = {}) {
    super({ sinkId: { type: 'none' }, ...options });
  }
};

// superdough skips worklet loading when `window` is undefined, so alias it to globalThis.
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.postMessage ??= () => {};

// Minimal document stub. The Strudel logger dispatches CustomEvents on it; beyond
// that only visual helpers (scope, spectrum, reverb graphs) touch it.
globalThis.document ??= Object.assign(new EventTarget(), {
  createElement: () => ({ getContext: () => null, style: {}, appendChild() {}, remove() {} }),
  querySelector: () => null,
  getElementById: () => null,
  body: { appendChild() {}, removeChild() {} },
});
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

installFetch();
