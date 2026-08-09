import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(projectRoot, 'dist');

const excludedDirectories = new Set([
  '.git',
  '.github',
  'dist',
  'node_modules',
  'scripts',
  'tests'
]);

const excludedFiles = new Set([
  '.DS_Store',
  'jest.config.js',
  'package-lock.json',
  'package.json'
]);

function shouldCopy(sourcePath) {
  const relativePath = path.relative(projectRoot, sourcePath);
  if (!relativePath) return true;

  const pathParts = relativePath.split(path.sep);
  if (pathParts.some(part => excludedDirectories.has(part))) return false;

  const fileName = path.basename(sourcePath);
  return !excludedFiles.has(fileName) && path.extname(fileName).toLowerCase() !== '.zip';
}

const sourceManifest = JSON.parse(
  await readFile(path.join(projectRoot, 'manifest.json'), 'utf8')
);

const declaredWebResources = new Set(
  sourceManifest.web_accessible_resources?.flatMap(entry => entry.resources || []) || []
);

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

const injectedModuleGraph = await collectLocalModuleGraph('injected/index.js');
const undeclaredInjectedModules = [...injectedModuleGraph]
  .filter(modulePath => !declaredWebResources.has(modulePath));

if (undeclaredInjectedModules.length > 0) {
  throw new Error(
    `Injected modules missing from web_accessible_resources: ${undeclaredInjectedModules.join(', ')}`
  );
}

if (!sourceManifest.browser_specific_settings?.gecko) {
  throw new Error('manifest.json must contain the Firefox browser_specific_settings.gecko configuration.');
}

const targets = [
  {
    name: 'chromium',
    manifest: (() => {
      const manifest = structuredClone(sourceManifest);
      delete manifest.browser_specific_settings;
      return manifest;
    })()
  },
  {
    name: 'firefox',
    manifest: structuredClone(sourceManifest)
  }
];

await rm(distDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });

for (const target of targets) {
  const targetDirectory = path.join(distDirectory, target.name);
  await mkdir(targetDirectory, { recursive: true });

  const projectEntries = await readdir(projectRoot);
  await Promise.all(projectEntries.map(async entryName => {
    const sourcePath = path.join(projectRoot, entryName);
    if (!shouldCopy(sourcePath)) return;

    await cp(sourcePath, path.join(targetDirectory, entryName), {
      recursive: true,
      filter: shouldCopy
    });
  }));

  await writeFile(
    path.join(targetDirectory, 'manifest.json'),
    `${JSON.stringify(target.manifest, null, 4)}\n`
  );

  const archivePath = path.join(distDirectory, `paramount-quality-plus-${target.name}.zip`);
  const zipResult = spawnSync('zip', ['-q', '-r', archivePath, '.'], {
    cwd: targetDirectory,
    encoding: 'utf8'
  });

  if (zipResult.error) {
    throw new Error(`Unable to start the zip command: ${zipResult.error.message}`);
  }
  if (zipResult.status !== 0) {
    throw new Error(`Failed to create ${path.basename(archivePath)}: ${zipResult.stderr.trim()}`);
  }

  console.log(`Built ${path.relative(projectRoot, targetDirectory)}`);
  console.log(`Built ${path.relative(projectRoot, archivePath)}`);
}
