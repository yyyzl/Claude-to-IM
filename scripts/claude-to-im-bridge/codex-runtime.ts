/** 仅在启动时发现本机 Codex，验证版本并选择可用运行时。 */
import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MINIMUM_VERSION = '0.160.0';
const MAX_PATH_PROBES = 8;

/** 已验证的运行时；binary 为真实入口，不包含 shell 参数。 */
export interface CodexRuntime {
  binary: string;
  version: string;
  source: 'explicit' | 'path' | 'desktop' | 'project';
}

/** 最小文件系统接口，便于离线覆盖不同平台的安装布局。 */
export interface CodexRuntimeFileSystem {
  isFile: (filename: string) => boolean;
  readFile: (filename: string) => string;
  realpath: (filename: string) => string;
}

/** 测试须注入 probe；生产探测只允许带参数数组的 --version。 */
export interface CodexRuntimeDependencies {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  fileSystem: CodexRuntimeFileSystem;
  resolveProjectManifest: (projectRoot: string) => string;
  probe: (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;
}

const localFileSystem: CodexRuntimeFileSystem = {
  isFile: filename => {
    try { return fs.statSync(filename).isFile(); } catch { return false; }
  },
  readFile: filename => fs.readFileSync(filename, 'utf8'),
  realpath: filename => fs.realpathSync(filename),
};

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function parseVersion(output: string): string {
  const match = /^codex-cli ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(output.trim());
  if (!match || !match[1].split('.').every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error('无法识别 Codex 正式版本；--version 应返回 codex-cli x.y.z');
  }
  if (compareVersions(match[1], MINIMUM_VERSION) < 0) {
    throw new Error(`Codex 版本 ${match[1]} 低于桥接协议要求 ${MINIMUM_VERSION}`);
  }
  return match[1];
}

/** 显式配置优先，否则选择最新本机正式版，仅无可用本机安装时使用项目依赖。 */
export function resolveCodexRuntime(
  userSpecified?: string,
  projectRoot = DEFAULT_PROJECT_ROOT,
  dependencies: Partial<CodexRuntimeDependencies> = {},
): CodexRuntime {
  if (process.env.NODE_TEST_CONTEXT && !dependencies.probe) {
    throw new Error('测试禁止探测真实 Codex 进程，请注入 probe');
  }
  const platform = dependencies.platform ?? process.platform;
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const root = paths.resolve(projectRoot);
  const env = dependencies.env ?? process.env;
  const files = dependencies.fileSystem ?? localFileSystem;
  const probe = dependencies.probe ?? ((command, args, options) => execFileSync(command, args, options));
  const key = (filename: string): string => windows ? filename.toLowerCase() : filename;
  const environment = (name: string): string | undefined => env[name]
    ?? (windows ? Object.entries(env).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[1] : undefined);
  const isInside = (filename: string, directory: string): boolean => {
    const relative = paths.relative(key(directory), key(filename));
    return !relative || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
  };
  let projectModulesDirectory = paths.join(root, 'node_modules');
  try { projectModulesDirectory = files.realpath(projectModulesDirectory); } catch {
    // 项目依赖可能尚未安装，此时保留逻辑路径用于排除。
  }

  // 以桥接安装目录解析依赖；聊天任务的 cwd 不参与发现。
  let projectEntry: string | undefined;
  let projectPackageDirectory: string | undefined;
  try {
    const manifestPath = dependencies.resolveProjectManifest
      ? dependencies.resolveProjectManifest(root)
      : createRequire(paths.join(root, 'package.json')).resolve('@openai/codex/package.json');
    const manifest: unknown = JSON.parse(files.readFile(manifestPath));
    if (!manifest || typeof manifest !== 'object' || !('bin' in manifest)) throw new Error('缺少 bin');
    const bin = manifest.bin;
    if (!bin || typeof bin !== 'object' || !('codex' in bin) || typeof bin.codex !== 'string') throw new Error('缺少 bin.codex');
    projectPackageDirectory = files.realpath(paths.dirname(manifestPath));
    projectEntry = paths.resolve(paths.dirname(manifestPath), bin.codex);
  } catch {
    // 本机已有可用运行时时，项目依赖缺失不阻止启动。
  }

  const directories: string[] = [];
  const directoryKeys = new Set<string>();
  const addDirectory = (value: string): void => {
    const directory = value.trim().replace(/^"(.*)"$/, '$1');
    if (!paths.isAbsolute(directory)) return;
    const normalized = paths.normalize(directory);
    if (!directoryKeys.has(key(normalized))) {
      directoryKeys.add(key(normalized));
      directories.push(normalized);
    }
  };
  for (const directory of (environment('PATH') ?? '').split(paths.delimiter)) addDirectory(directory);
  if (windows && environment('APPDATA')) addDirectory(paths.join(environment('APPDATA') ?? '', 'npm'));
  const names = windows ? ['codex.exe', 'codex.com', 'codex.cmd', 'codex.bat', 'codex.ps1', 'codex'] : ['codex'];

  const normalizeBinary = (filename: string): string => {
    if (!files.isFile(filename)) throw new Error('入口文件不存在');
    const real = files.realpath(filename);
    if (!windows || /\.(?:exe|com|[cm]?js)$/i.test(real)) return real;
    // npm 的 Windows shim 不能直接执行；仅归一官方包的 JS 入口。
    const shim = files.readFile(real);
    const normalizedShim = shim.replaceAll('\\', '/');
    const npmEntry = paths.basename(paths.dirname(real)).toLowerCase() === '.bin'
      ? paths.resolve(paths.dirname(real), '../@openai/codex/bin/codex.js')
      : paths.join(paths.dirname(real), 'node_modules/@openai/codex/bin/codex.js');
    if (/(?:\.\.\/|node_modules\/)@openai\/codex\/bin\/codex\.js/.test(normalizedShim) && files.isFile(npmEntry)) {
      return files.realpath(npmEntry);
    }
    throw new Error('不支持此 Windows 包装脚本；请指定 Codex 的 .exe 或官方 bin/codex.js 入口');
  };

  const inspect = (binary: string, source: CodexRuntime['source']): CodexRuntime => {
    const isJavaScript = /\.[cm]?js$/i.test(binary);
    let output: string;
    try {
      output = probe(isJavaScript ? process.execPath : binary, isJavaScript ? [binary, '--version'] : ['--version'], {
        encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024, windowsHide: true,
        cwd: root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error('无法执行 --version，可能探测超时或安装损坏');
    }
    return { binary, version: parseVersion(output), source };
  };

  const explicit = userSpecified?.trim();
  if (explicit) {
    try {
      let filename: string | undefined;
      if (paths.isAbsolute(explicit) || /[\\/]/.test(explicit)) filename = paths.resolve(root, explicit);
      else {
        const explicitNames = windows && !paths.extname(explicit)
          ? [explicit + '.exe', explicit + '.com', explicit + '.cmd', explicit + '.bat', explicit + '.ps1', explicit]
          : [explicit];
        filename = directories.flatMap(directory => explicitNames.map(name => paths.join(directory, name)))
          .find(candidate => files.isFile(candidate));
      }
      if (!filename) throw new Error('PATH 中未找到指定入口');
      return inspect(normalizeBinary(filename), 'explicit');
    } catch (error) {
      const message = error instanceof Error ? error.message : '入口不可用';
      throw new Error(`bridge_codex_bin 指定的 Codex 不可用：${message}。请修正配置后重启。`);
    }
  }

  const visited = new Set<string>();
  let pathProbeCount = 0;
  let selected: CodexRuntime | undefined;
  const consider = (filename: string, source: 'path' | 'desktop'): void => {
    // 最多 8 个 PATH 候选，另保留桌面与项目各一次；总探测上限 20 秒。
    if (source === 'path' && pathProbeCount >= MAX_PATH_PROBES) return;
    if (/(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/i.test(filename)) return;
    try {
      const binary = normalizeBinary(filename);
      if (isInside(binary, projectModulesDirectory)
          || (projectPackageDirectory && isInside(binary, projectPackageDirectory))) return;
      if (visited.has(key(binary))) return;
      visited.add(key(binary));
      if (source === 'path') pathProbeCount++;
      const runtime = inspect(binary, source);
      // PATH 先加入，因此同版本保留用户 CLI。
      if (!selected || compareVersions(runtime.version, selected.version) > 0) selected = runtime;
    } catch {
      // 自动候选失效时继续检查其它本机安装，最后再尝试项目依赖。
    }
  };
  for (const directory of directories) {
    for (const name of names) consider(paths.join(directory, name), 'path');
  }
  const codexHome = environment('CODEX_HOME') || paths.join(dependencies.homeDirectory ?? os.homedir(), '.codex');
  if (paths.isAbsolute(codexHome)) {
    consider(paths.join(codexHome, 'packages/app-server-daemon/current/bin', windows ? 'codex.exe' : 'codex'), 'desktop');
  }
  if (selected) return selected;
  if (projectEntry) {
    try { return inspect(normalizeBinary(projectEntry), 'project'); } catch (error) {
      const message = error instanceof Error ? error.message : '入口不可用';
      throw new Error(`未找到可用的本机 Codex，且项目依赖不可用：${message}。请更新本机 Codex、运行 npm install，或配置 bridge_codex_bin。`);
    }
  }
  throw new Error('未找到可用的本机 Codex 或项目依赖 @openai/codex；请安装 Codex、运行 npm install，或配置 bridge_codex_bin。');
}
