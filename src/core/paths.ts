/**
 * Cross-platform state locations. The controller runs on Linux, Windows and
 * macOS, so nothing here assumes POSIX layout. `NETBLOCK_HOME` overrides
 * everything, which is what the test suite and portable installs use.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export function stateDir(role: 'controller' | 'device'): string {
  const override = process.env.NETBLOCK_HOME;
  if (override !== undefined && override.length > 0) return path.join(override, role);

  const home = os.homedir();
  switch (os.platform()) {
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'NetBlock', role);
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'NetBlock', role);
    default: {
      const xdg = process.env.XDG_STATE_HOME;
      const base = xdg !== undefined && xdg.length > 0 ? xdg : path.join(home, '.local', 'state');
      return path.join(base, 'netblock', role);
    }
  }
}

/**
 * Presence of this file is the offline release request. A file is used
 * deliberately: it needs no network, no running listener and no working UI, so
 * the owner can always get their restrictions cleared.
 */
export const RELEASE_REQUEST_FILE = 'release.request';
