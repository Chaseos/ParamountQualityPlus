import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function collectLocalModuleGraph(relativeModulePath, visited = new Set()) {
  const normalizedPath = relativeModulePath.split(path.sep).join('/');
  if (visited.has(normalizedPath)) return visited;
  visited.add(normalizedPath);

  const source = await readFile(path.join(projectRoot, normalizedPath), 'utf8');
  const importPattern = /(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(normalizedPath), match[1]));
    await collectLocalModuleGraph(dependency, visited);
  }
  return visited;
}

test('declares every injected module dependency as a web-accessible resource', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
  const declaredResources = new Set(
    manifest.web_accessible_resources.flatMap(entry => entry.resources || [])
  );
  const moduleGraph = await collectLocalModuleGraph('injected/index.js');

  expect([...moduleGraph].filter(modulePath => !declaredResources.has(modulePath))).toEqual([]);
});
