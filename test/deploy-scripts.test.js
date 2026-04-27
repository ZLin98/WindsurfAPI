import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const updateScript = readFileSync(new URL('../update.sh', import.meta.url), 'utf8');
const installLsScript = readFileSync(new URL('../install-ls.sh', import.meta.url), 'utf8');

describe('deployment scripts', () => {
  it('does not trust release content-length or require PM2 unconditionally', () => {
    assert.doesNotMatch(updateScript, /curl\s+-sI\s+-L\s+"\$RELEASE_URL"/);
    assert.doesNotMatch(updateScript, /REMOTE_SIZE=.*curl/);
    assert.match(updateScript, /SERVICE_MANAGER/);
    assert.match(updateScript, /nohup env PORT="\$PORT" node src\/index\.js/);
  });

  it('downloads LS binaries through a temp file before replacing the current binary', () => {
    assert.match(installLsScript, /download_to_target\(\)/);
    assert.match(installLsScript, /"\$\{target\}\.tmp\.\$\$"/);
    assert.doesNotMatch(installLsScript, /curl[^\n]+-o "\$TARGET"/);
  });
});
