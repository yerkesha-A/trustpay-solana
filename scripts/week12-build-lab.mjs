// Builds only the corrected artifact. No deployment or insecure feature flag.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.anchor/week12-lab/fixed', { recursive:true });
const result = spawnSync('cargo-build-sbf', [
  '--manifest-path', 'labs/security-vault/Cargo.toml',
  '--sbf-out-dir', '.anchor/week12-lab/fixed', '--', '--locked', '--offline',
], { encoding:'utf8', env:{...process.env, CARGO_TARGET_DIR:`${process.cwd()}/target/security-lab`}, maxBuffer:8*1024*1024 });
writeFileSync('.anchor/week12-lab/fixed-build.log', (result.stdout || '')+(result.stderr || ''));
if (result.error || result.status !== 0) {
  console.error(result.error?.message || result.stderr.slice(-5000)); process.exit(1);
}
console.log('PASS: corrected Security Lab SBF built offline; no deployment');
