import fs from 'node:fs';
import path from 'node:path';

/** macOS system Chrome. */
export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LINUX = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];

/** Platform system-browser locations (macOS, Linux, Windows). */
export function systemCandidates(env = process.env, platform = process.platform) {
  if (platform === 'darwin') return [SYSTEM_CHROME];
  if (platform === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter(Boolean).map((root) => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return LINUX;
}

/** Candidate Chrome executables in priority order: env override, bundled puppeteer Chrome, system Chrome. */
export function executableCandidates(puppeteer) {
  const list = [];
  if (process.env.PUPPETEER_EXECUTABLE_PATH) list.push(process.env.PUPPETEER_EXECUTABLE_PATH);
  try { list.push(puppeteer.executablePath()); } catch { /* no bundled browser */ }
  list.push(...systemCandidates());
  return [...new Set(list)].filter((p) => p && fs.existsSync(p));
}

/** --no-sandbox is allowed only when GAJ_NO_SANDBOX=1 or running as root on Linux. */
export function noSandboxAllowed(env = process.env, platform = process.platform) {
  return env.GAJ_NO_SANDBOX === '1' || (platform === 'linux' && process.getuid?.() === 0);
}

/**
 * Launch headless Chrome via puppeteer. Each candidate is tried with the sandbox first; a --no-sandbox
 * retry happens only when noSandboxAllowed(). Caller must close the browser.
 */
export async function launchBrowser() {
  const puppeteer = (await import('puppeteer')).default;
  const errors = [];
  const attempts = noSandboxAllowed() ? [[], ['--no-sandbox']] : [[]];
  for (const executablePath of executableCandidates(puppeteer)) {
    for (const extra of attempts) {
      try {
        return await puppeteer.launch({ headless: true, executablePath, args: ['--disable-gpu', ...extra] });
      } catch (err) {
        errors.push(`${executablePath}${extra.length ? ' (--no-sandbox)' : ''}: ${err.message.split('\n')[0]}`);
      }
    }
  }
  throw new Error([
    'Could not launch Chrome.',
    'Hints: set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium binary, or run "npx puppeteer browsers install chrome".',
    'In containers/CI where the Chrome sandbox is unavailable, set GAJ_NO_SANDBOX=1 to allow a --no-sandbox retry.',
    ...errors,
  ].join('\n'));
}
