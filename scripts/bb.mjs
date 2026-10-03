import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const bundled = '/Applications/BB.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb.js';
const cli = process.env.BB_CLI_PATH || (existsSync(bundled) ? bundled : null);
const result = spawnSync(cli ? process.execPath : 'bb', [...(cli ? [cli] : []), ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) console.error(`Could not run BB: ${result.error.message}. Install BB or set BB_CLI_PATH.`);
process.exit(result.status ?? 1);
