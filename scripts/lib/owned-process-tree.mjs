import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

/** Spawn a process in its own Unix process group. Windows tree ownership is
 * established by the root PID and terminated with taskkill /T /F. */
export function spawnOwnedProcess(executable, args, options = {}) {
  return spawn(executable, args, {
    ...options,
    detached: process.platform === 'win32' ? false : true,
  });
}

/** Terminate the complete owned process tree and wait for the root close event.
 * Callers should mark the operation timed out before awaiting this function so
 * their normal close handler cannot report a successful completion. */
export async function terminateOwnedProcessTree(child, { graceMs = 2_000 } = {}) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  const closed = once(child, 'close').then(() => true, () => true);

  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise(resolvePromise => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolvePromise());
      killer.once('close', () => resolvePromise());
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  }

  if (await Promise.race([closed, delay(graceMs).then(() => false)])) return;

  if (process.platform === 'win32') {
    try { child.kill(); } catch { /* already gone */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }

  if (!await Promise.race([closed, delay(graceMs).then(() => false)])) {
    throw new Error(`Process tree rooted at PID ${child.pid} did not close after termination.`);
  }
}

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}
