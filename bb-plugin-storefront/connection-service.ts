import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Login, Profile, Storefront, Selection } from './connection-contract';
import { assertPagePath, parsePages, parsePageDetail, parseTemplates } from './storefront-data.ts';

type Config = { nodePath: string; cliPath: string };
const LIMIT = 4 * 1024 * 1024;
function readJson(text: string): any {
  try { return JSON.parse(text); }
  catch { throw new Error('The toolkit returned an unreadable response. Check the installed version.'); }
}
export function assertProfile(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('Use 1–64 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.');
}
export function parseChallenge(text: string): { url: string; code: string } | null {
  const match = text.match(/open this URL in your browser:\s*(https:\/\/\S+)\s+Enter code:\s*([A-Za-z0-9-]+)(?:\s|$)/);
  if (!match) return null;
  const url = new URL(match[1]);
  if (url.origin !== 'https://secure.ultracart.com' || url.username || url.password) throw new Error('The toolkit returned an unexpected login address. Update or inspect the installed toolkit.');
  return { url: url.toString(), code: match[2] };
}
export function parseStorefronts(value: unknown): { merchantId: string; storefronts: Storefront[] } {
  if (!value || typeof value !== 'object') throw new Error('Unexpected storefront response.');
  const result = value as Record<string, unknown>;
  if (typeof result.merchantId !== 'string' || !result.merchantId || !Array.isArray(result.storefronts)) throw new Error('Unexpected storefront response.');
  const storefronts = result.storefronts.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Unexpected storefront record.');
    const s = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(s.storefront_oid) || Number(s.storefront_oid) <= 0 || typeof s.host_name !== 'string' || !s.host_name) throw new Error('Unexpected storefront record.');
    return { id: Number(s.storefront_oid), host: s.host_name, themeId: Number.isSafeInteger(s.active_theme_oid) ? Number(s.active_theme_oid) : null };
  });
  return { merchantId: result.merchantId, storefronts };
}
export function safeFailure(text: string) {
  if (/rate.limit|429/i.test(text)) return 'UltraCart rate limited the request. Wait at least one minute before retrying.';
  if (/locked|keychain|credential store|native_binding/i.test(text)) return 'The OS credential store is unavailable or locked. Unlock it, then try again.';
  if (/access_denied|authorization_declined/i.test(text)) return 'Authorization was declined. You can start again when ready.';
  if (/expired_token|expired/i.test(text)) return 'The sign-in request expired. Start a new sign-in.';
  if (/invalid_grant|unauthenticated|401|no.*credential|not authenticated/i.test(text)) return 'This profile needs sign-in. Authorize it in UltraCart, then retry.';
  if (/merchant.*mismatch|identity.*mismatch/i.test(text)) return 'The merchant does not match this profile. Choose the correct profile or sign in with a new profile name.';
  return 'The toolkit could not complete the request. Check the selected profile, network, and installed toolkit, then retry.';
}

export class ConnectionService {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private login: Login | null = null;
  private loginChild: ChildProcessWithoutNullStreams | null = null;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private disposed = false;
  private pending = 0;
  private queue: Promise<void> = Promise.resolve();
  private getConfig: () => Promise<Config>;
  constructor(getConfig: () => Promise<Config>) { this.getConfig = getConfig; }

  private async command(args: string[]) {
    if (this.disposed) throw new Error('The plugin reloaded. Refresh this panel.');
    const config = await this.getConfig();
    if (!isAbsolute(config.nodePath) || !isAbsolute(config.cliPath)) throw new Error('Configure absolute Node 24 and toolkit CLI paths in the Storefront plugin settings.');
    return { command: config.nodePath, args: [config.cliPath, ...args], options: {
      cwd: homedir(), shell: false as const,
      env: { ...process.env, PATH: `${dirname(config.nodePath)}:${process.env.PATH || ''}`, ULTRACART_PROFILE: '', NO_COLOR: '1' },
      stdio: 'pipe' as const,
    } };
  }
  async run(args: string[]): Promise<string> {
    if (this.loginChild || this.login?.phase === 'starting') throw new Error('Another toolkit request is in progress. Finish or cancel it first.');
    if (this.pending >= 12) throw new Error('The toolkit is busy. Wait for the current requests to finish.');
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    this.pending++;
    try { await previous; return await this.runNow(args); }
    finally { this.pending--; release(); }
  }
  private async runNow(args: string[]): Promise<string> {
    if (this.busy || this.loginChild) throw new Error('Another toolkit request is in progress. Finish or cancel it first.');
    this.busy = true;
    try {
      const invocation = await this.command(args);
      if (this.disposed) throw new Error('The plugin reloaded. Refresh this panel.');
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, invocation.options);
        this.children.add(child);
        let stdout = '', stderr = '', finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true; clearTimeout(timer); this.children.delete(child);
          if (error) reject(error); else resolve(stdout.trim());
        };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('The toolkit request timed out. Try again when the connection is available.')); }, 30000);
        child.stdin.end();
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > LIMIT) { child.kill('SIGKILL'); finish(new Error('The toolkit response exceeded the size limit.')); } });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-LIMIT); });
        child.on('error', () => finish(new Error('The toolkit could not start. Check Node 24 and the CLI path in plugin settings.')));
        child.on('close', code => finish(code === 0 ? undefined : new Error(safeFailure(stderr + stdout))));
      });
    } finally { this.busy = false; }
  }
  async inspect(): Promise<{ version: string; profiles: Profile[] }> {
    const version = await this.run(['--version']);
    const data = readJson(await this.run(['--format', 'json', 'profile', 'list']));
    if (!Array.isArray(data.profiles)) throw new Error('Unexpected profile response.');
    const profiles: Profile[] = data.profiles.map((p: Record<string, unknown>) => {
      if (typeof p.id !== 'string' || typeof p.name !== 'string') throw new Error('Unexpected profile response.');
      return { id: p.id, name: p.name, merchantId: typeof p.merchantId === 'string' ? p.merchantId : null };
    });
    return { version, profiles };
  }
  async storefronts(profile: string) {
    assertProfile(profile);
    return parseStorefronts(readJson(await this.run(['--format', 'json', '--profile', profile, 'sf', 'storefronts'])));
  }
  async verify(selection: Selection) {
    const result = await this.storefronts(selection.profileId);
    if (result.merchantId !== selection.merchantId) throw new Error('Merchant identity changed. Reconnect the intended store.');
    const store = result.storefronts.find(s => s.id === selection.storefront.id);
    if (!store || store.host !== selection.storefront.host) throw new Error('The selected storefront is no longer available. Reconnect your store.');
    return store;
  }
  async pages(selection: Selection) {
    await this.verify(selection);
    return parsePages(readJson(await this.run(['--format', 'json', '--profile', selection.profileId, 'sf', 'pages', 'list', '--storefront', String(selection.storefront.id)])), selection.storefront.id);
  }
  async page(selection: Selection, path: string) {
    assertPagePath(path);
    await this.verify(selection);
    return parsePageDetail(readJson(await this.run(['--format', 'json', '--profile', selection.profileId, 'sf', 'pages', 'get', '--storefront', String(selection.storefront.id), '--path', path])), selection.storefront.id, path);
  }
  async templates(selection: Selection, path: string) {
    assertPagePath(path);
    await this.verify(selection);
    return parseTemplates(readJson(await this.run(['--format', 'json', '--profile', selection.profileId, 'sf', 'template', 'find', '--storefront', String(selection.storefront.id), '--uri', path])), selection.storefront.id, path);
  }
  async begin(profile: string): Promise<Login> {
    assertProfile(profile);
    if (this.pending || this.busy || this.loginChild || this.login?.phase === 'starting') throw new Error('Another toolkit request is in progress. Finish or cancel it first.');
    const id = randomUUID();
    this.login = { id, profile, phase: 'starting', url: null, code: null, message: 'Starting UltraCart sign-in…' };
    try {
      const invocation = await this.command(['--format', 'json', 'auth', 'login', '--profile', profile]);
      if (this.disposed || this.login.phase !== 'starting') throw new Error('Sign-in cancelled.');
      const child = spawn(invocation.command, invocation.args, invocation.options);
      this.loginChild = child; this.children.add(child); child.stdin.end();
      let stderr = '', stdout = '';
      const finish = (phase: Login['phase'], message: string) => {
        if (this.loginTimer) clearTimeout(this.loginTimer);
        this.loginTimer = null; this.children.delete(child);
        if (this.loginChild === child) this.loginChild = null;
        if (this.login?.id === id && ['starting', 'waiting'].includes(this.login.phase)) this.login = { id, profile, phase, message, url: null, code: null };
        stderr = ''; stdout = '';
      };
      this.loginTimer = setTimeout(() => { child.kill('SIGKILL'); finish('failed', 'Sign-in timed out. Start a new request.'); }, 10 * 60 * 1000);
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-LIMIT);
        if (this.login?.id !== id || !['starting', 'waiting'].includes(this.login.phase)) return;
        try {
          const challenge = parseChallenge(stderr);
          if (challenge) this.login = { id, profile, phase: 'waiting', ...challenge, message: 'Complete sign-in in UltraCart, then return here.' };
        } catch {
          child.kill('SIGKILL'); finish('failed', 'Unexpected authorization address. Check the installed toolkit.');
        }
      });
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > LIMIT) { child.kill('SIGKILL'); finish('failed', 'Unexpected sign-in response.'); } });
      child.on('error', () => finish('failed', 'Could not start the toolkit. Check the configured paths.'));
      child.on('close', code => {
        if (code !== 0) { finish('failed', safeFailure(stderr + stdout)); return; }
        try {
          const result = JSON.parse(stdout);
          if (result.action !== 'auth.login' || typeof result.identity?.merchantId !== 'string') throw new Error();
          finish('succeeded', 'Signed in. Load the storefronts for this profile.');
        } catch { finish('failed', 'Could not verify the login result. Refresh profiles before retrying.'); }
      });
      return { ...this.login };
    } catch (error) { this.login = null; throw error; }
  }
  loginStatus(id: string): Login {
    if (!this.login || this.login.id !== id) throw new Error('This sign-in session is no longer active. Start a new sign-in.');
    return { ...this.login };
  }
  cancel(id: string): Login {
    const state = this.loginStatus(id);
    if (!['starting', 'waiting'].includes(state.phase)) return state;
    this.login = { ...state, phase: 'cancelled', message: 'Sign-in cancelled. Any profile already created remains available.', url: null, code: null };
    this.loginChild?.kill('SIGKILL');
    if (this.loginTimer) clearTimeout(this.loginTimer);
    return { ...this.login };
  }
  dispose() {
    this.disposed = true;
    if (this.loginTimer) clearTimeout(this.loginTimer);
    for (const child of this.children) child.kill('SIGKILL');
    this.children.clear(); this.login = null; this.loginChild = null;
  }
}
