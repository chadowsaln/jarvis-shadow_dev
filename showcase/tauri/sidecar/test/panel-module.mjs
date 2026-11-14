// The panel is a web page: it loads its modules the way a browser does (an ES module, by URL). Node reads a bare
// .js outside a "type": "module" package as CommonJS, so tests run the same bytes through a data: URL - what is
// tested is the file the panel loads, not a copy of it.
import { readFile } from 'node:fs/promises';

export async function loadPanelModule(name) {
  const src = await readFile(new URL(`../../../panel/${name}`, import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}
