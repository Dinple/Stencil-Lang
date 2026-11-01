// Run the integration suite in a real VS Code (downloaded into .vscode-test/).
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
await runTests({
  extensionDevelopmentPath: resolve(here, '../..'),
  extensionTestsPath: resolve(here, 'suite.cjs'),
  launchArgs: [resolve(here, 'fixtures'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
});
