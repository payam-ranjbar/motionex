// soundfont2's Node build is a UMD bundle whose named exports Node can't detect;
// sfumato (used by @strudel/soundfonts) imports them by name.
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('soundfont2');

export const { SoundFont2, DEFAULT_GENERATOR_VALUES } = pkg;
export default pkg;
