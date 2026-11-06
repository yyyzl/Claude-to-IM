import assert from 'node:assert/strict';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CodexRuntimeDependencies } from '../scripts/claude-to-im-bridge/codex-runtime.ts';
import { resolveCodexRuntime } from '../scripts/claude-to-im-bridge/codex-runtime.ts';

function fixture(options: { platform?: NodeJS.Platform; root?: string; project?: boolean } = {}) {
  const platform = options.platform ?? 'win32';
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = options.root ?? (platform === 'win32' ? 'G:\\bridge' : '/bridge');
  const homeDirectory = platform === 'win32' ? 'C:\\Users\\tester' : '/home/tester';
  const normalize = (filename: string) => {
    const value = paths.normalize(filename);
    return platform === 'win32' ? value.toLowerCase() : value;
  };
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  const outputs = new Map<string, string | Error>();
  const calls: Array<{ command: string; args: string[]; options: ExecFileSyncOptionsWithStringEncoding }> = [];
  const realpath = (filename: string) => links.get(normalize(filename)) ?? paths.normalize(filename);
  const addFile = (filename: string, contents = '') => files.set(normalize(filename), contents);
  const addRuntime = (filename: string, version: string) => {
    addFile(filename);
    outputs.set(normalize(filename), `codex-cli ${version}\r\n`);
    return filename;
  };
  const manifest = paths.join(root, 'node_modules/@openai/codex/package.json');
  const projectBinary = paths.join(root, 'node_modules/@openai/codex/bin/codex.js');
  if (options.project !== false) {
    addFile(manifest, JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    addRuntime(projectBinary, '0.160.0');
  }
  const dependencies: CodexRuntimeDependencies = {
    platform, env: { PATH: '' }, homeDirectory,
    fileSystem: {
      isFile: filename => files.has(normalize(realpath(filename))),
      readFile: filename => {
        const contents = files.get(normalize(realpath(filename)));
        if (contents === undefined) throw new Error('ENOENT');
        return contents;
      },
      realpath,
    },
    resolveProjectManifest: actualRoot => {
      assert.equal(actualRoot, root);
      return manifest;
    },
    probe: (command, args, probeOptions) => {
      calls.push({ command, args, options: probeOptions });
      const binary = command === process.execPath ? args[0] : command;
      const output = outputs.get(normalize(binary));
      if (output instanceof Error) throw output;
      if (output === undefined) throw new Error('未注入运行时结果');
      return output;
    },
  };
  const addNpm = (directory: string, version: string) => {
    const binary = addRuntime(paths.join(directory, 'node_modules/@openai/codex/bin/codex.js'), version);
    for (const name of ['codex.cmd', 'codex.ps1', 'codex']) {
      addFile(paths.join(directory, name), '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js"');
    }
    return binary;
  };
  const desktopPath = (codexHome = paths.join(homeDirectory, '.codex')) =>
    paths.join(codexHome, 'packages/app-server-daemon/current/bin', platform === 'win32' ? 'codex.exe' : 'codex');
  return {
    root, paths, dependencies, files, links, outputs, calls, projectBinary, manifest,
    addFile, addRuntime, addNpm, desktopPath, normalize,
    setPath: (...directories: string[]) => { dependencies.env.PATH = directories.join(paths.delimiter); },
    resolve: (explicit?: string) => resolveCodexRuntime(explicit, root, dependencies),
  };
}

test('PATH 首位的项目 .bin 不遮蔽全局 Codex，npm shim 归一为 JS', () => {
  const f = fixture();
  const localBin = f.paths.join(f.root, 'node_modules/.bin');
  f.addFile(f.paths.join(localBin, 'codex.cmd'), '"%dp0%\\..\\@openai\\codex\\bin\\codex.js"');
  const globalBinary = f.addNpm('C:\\npm', '0.166.0');
  f.setPath(localBin, 'C:\\npm');
  assert.deepEqual(f.resolve(), { binary: globalBinary, version: '0.166.0', source: 'path' });
  assert.equal(f.calls.length, 1);
});

test('较新的桌面 current 胜出，固定为探测时的真实版本路径', () => {
  const f = fixture();
  f.addNpm('C:\\npm', '0.166.0');
  f.setPath('C:\\npm');
  const release = f.addRuntime('C:\\codex-releases\\0.167.0\\codex.exe', '0.167.0');
  f.links.set(f.normalize(f.desktopPath()), release);
  f.addRuntime('C:\\codex-releases\\9.0.0\\codex.exe', '9.0.0');
  assert.deepEqual(f.resolve(), { binary: release, version: '0.167.0', source: 'desktop' });
  assert.equal(f.calls.length, 2, '不扫描 releases 历史版本');
});

test('显式路径覆盖较新的自动候选，也可以固定项目版本', () => {
  const f = fixture();
  f.addRuntime(f.desktopPath(), '0.167.0');
  assert.deepEqual(f.resolve(`  ${f.projectBinary}  `), {
    binary: f.projectBinary, version: '0.160.0', source: 'explicit',
  });
  assert.equal(f.calls.length, 1);
});

test('显式相对路径以桥接安装目录为基准，显式命令可在 PATH 中解析', () => {
  const f = fixture();
  const explicitBinary = f.addRuntime(f.paths.join(f.root, 'runtime/codex.exe'), '0.165.0');
  assert.equal(f.resolve('./runtime/codex.exe').binary, explicitBinary);
  const globalBinary = f.addNpm('C:\\npm', '0.166.0');
  f.setPath('C:\\npm');
  assert.deepEqual(f.resolve('codex'), { binary: globalBinary, version: '0.166.0', source: 'explicit' });
});

test('版本按数值比较，同版本优先 PATH', () => {
  const f = fixture();
  f.addRuntime('C:\\first\\codex.exe', '0.999.0');
  const newest = f.addRuntime('C:\\second\\codex.exe', '0.1000.0');
  f.addRuntime(f.desktopPath(), '0.1000.0');
  f.setPath('C:\\first', 'C:\\second');
  assert.deepEqual(f.resolve(), { binary: newest, version: '0.1000.0', source: 'path' });
});

test('PATH 大小写重复、多个 npm shim 和符号链接只探测同一入口一次', () => {
  const f = fixture();
  const binary = f.addNpm('C:\\npm', '0.166.0');
  f.links.set(f.normalize('C:\\alias\\codex.exe'), binary);
  f.links.set(f.normalize(f.desktopPath()), binary);
  f.setPath('C:\\npm', 'C:\\NPM', 'C:\\alias');
  assert.equal(f.resolve().binary, binary);
  assert.equal(f.calls.length, 1);
});

test('PATH 中指向本项目依赖的外部链接不算本机安装', () => {
  const f = fixture();
  f.links.set(f.normalize('C:\\alias\\codex.exe'), f.projectBinary);
  const globalBinary = f.addRuntime('C:\\global\\codex.exe', '0.166.0');
  f.setPath('C:\\alias', 'C:\\global');
  assert.equal(f.resolve().binary, globalBinary);
  assert.equal(f.calls.length, 1);
});

test('Windows 从 APPDATA/npm 发现不在 PATH 中的 CLI，环境变量名大小写兼容', () => {
  const f = fixture();
  f.dependencies.env = { Path: '', AppData: 'C:\\Users\\tester\\AppData\\Roaming' };
  const binary = f.addNpm('C:\\Users\\tester\\AppData\\Roaming\\npm', '0.166.0');
  assert.equal(f.resolve().binary, binary);
});

test('桥接目录通过 junction 访问时，也排除项目原生 Codex 包的真实入口', () => {
  const f = fixture();
  f.links.set(f.normalize(f.paths.join(f.root, 'node_modules')), 'G:\\actual-bridge\\node_modules');
  const localNative = f.addRuntime('G:\\actual-bridge\\node_modules\\@openai\\codex-win32-x64\\bin\\codex.exe', '9.0.0');
  f.links.set(f.normalize('C:\\project-alias\\codex.exe'), localNative);
  const global = f.addRuntime('C:\\global\\codex.exe', '0.166.0');
  f.setPath('C:\\project-alias', 'C:\\global');
  assert.equal(f.resolve().binary, global);
  assert.equal(f.calls.length, 1);
});

test('CODEX_HOME 指定桌面 current，Unix 使用无扩展名的可执行文件', () => {
  const f = fixture({ platform: 'linux' });
  f.dependencies.env.CODEX_HOME = '/custom/codex';
  const binary = f.addRuntime(f.desktopPath('/custom/codex'), '0.167.0');
  f.addRuntime(f.desktopPath(), '0.170.0');
  assert.deepEqual(f.resolve(), { binary, version: '0.167.0', source: 'desktop' });
  assert.deepEqual(f.calls[0].args, ['--version']);
});

test('Unix PATH 中的 npm 符号链接归一为 JS，并使用当前 Node 启动', () => {
  const f = fixture({ platform: 'darwin' });
  const binary = f.addRuntime('/opt/npm/lib/node_modules/@openai/codex/bin/codex.js', '0.166.0');
  f.links.set('/opt/npm/bin/codex', binary);
  f.setPath('/opt/npm/bin');
  assert.equal(f.resolve().binary, binary);
  assert.equal(f.calls[0].command, process.execPath);
  assert.deepEqual(f.calls[0].args, [binary, '--version']);
});

test('缺失、损坏、超时、过旧、预发布和未知版本都不会被自动选中', () => {
  const f = fixture();
  const damaged = f.addRuntime('C:\\damaged\\codex.exe', '0.167.0');
  f.outputs.set(f.normalize(damaged), new Error('启动失败及敏感 stderr 不应回显'));
  const timeout = f.addRuntime('C:\\timeout\\codex.exe', '0.167.0');
  f.outputs.set(f.normalize(timeout), Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
  f.addRuntime('C:\\old\\codex.exe', '0.159.0');
  f.addRuntime('C:\\alpha\\codex.exe', '0.170.0-alpha.1');
  const unknown = f.addRuntime('C:\\unknown\\codex.exe', '0.170.0');
  f.outputs.set(f.normalize(unknown), 'some-other-cli 0.170.0');
  f.setPath('C:\\missing', 'C:\\damaged', 'C:\\timeout', 'C:\\old', 'C:\\alpha', 'C:\\unknown');
  assert.deepEqual(f.resolve(), { binary: f.projectBinary, version: '0.160.0', source: 'project' });
  assert.equal(f.calls.length, 6);
});

test('自动候选故障不阻止后续有效安装被选中', () => {
  const f = fixture();
  const broken = f.addRuntime('C:\\broken\\codex.exe', '0.170.0');
  f.outputs.set(f.normalize(broken), new Error('启动失败'));
  const binary = f.addRuntime('C:\\working\\codex.exe', '0.166.0');
  f.setPath('C:\\broken', 'C:\\working');
  assert.equal(f.resolve().binary, binary);
});

test('显式入口缺失、损坏、版本过旧或输出无法识别时明确报错，不回退', () => {
  const f = fixture();
  assert.throws(() => f.resolve('C:\\missing.exe'), /bridge_codex_bin.*入口文件不存在/);
  const broken = f.addRuntime('C:\\broken.exe', '0.167.0');
  f.outputs.set(f.normalize(broken), new Error('secret-stderr'));
  assert.throws(() => f.resolve(broken), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /bridge_codex_bin.*无法执行 --version/);
    assert.doesNotMatch(error.message, /secret-stderr/);
    return true;
  });
  const old = f.addRuntime('C:\\old.exe', '0.159.0');
  assert.throws(() => f.resolve(old), /低于桥接协议要求 0.160.0/);
  const unknown = f.addRuntime('C:\\unknown.exe', '0.170.0');
  f.outputs.set(f.normalize(unknown), 'codex-cli 0.170.0\nother output');
  assert.throws(() => f.resolve(unknown), /无法识别 Codex 正式版本/);
  assert.equal(f.calls.length, 3, '未探测项目兜底');
});

test('未知 Windows 包装脚本自动跳过，显式选择时提示实际入口', () => {
  const f = fixture();
  f.addFile('C:\\wrapper\\codex.cmd', '@echo custom wrapper');
  f.setPath('C:\\wrapper');
  assert.equal(f.resolve().source, 'project');
  assert.throws(() => f.resolve('C:\\wrapper\\codex.cmd'), /不支持此 Windows 包装脚本/);
  assert.equal(f.calls.length, 1);
});

test('带空格及 shell 特殊字符的 JS 路径仍作为单独参数，不拼接命令', () => {
  const f = fixture();
  const binary = f.addNpm('C:\\User Data & Tools\\npm', '0.166.0');
  f.setPath('"C:\\User Data & Tools\\npm"');
  assert.equal(f.resolve().binary, binary);
  const call = f.calls[0];
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, [binary, '--version']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 2_000);
  assert.equal(call.options.maxBuffer, 16 * 1024);
  assert.equal(call.options.windowsHide, true);
});

test('没有本机安装时回退项目依赖，项目缺失不妨碍已安装 CLI', () => {
  const f = fixture();
  assert.equal(f.resolve().source, 'project');
  const missing = fixture({ project: false });
  const binary = missing.addRuntime('C:\\installed\\codex.exe', '0.166.0');
  missing.setPath('C:\\installed');
  assert.equal(missing.resolve().binary, binary);
});

test('项目也不存在或不可运行时提供修复指引', () => {
  assert.throws(() => fixture({ project: false }).resolve(), /未找到可用的本机 Codex 或项目依赖.*npm install/);
  const f = fixture();
  f.outputs.set(f.normalize(f.projectBinary), new Error('broken'));
  assert.throws(() => f.resolve(), /项目依赖不可用.*npm install/);
});

test('切换聊天 cwd 不改变默认项目目录，忽略相对 PATH 项', () => {
  const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const f = fixture({ platform: process.platform, root });
  f.setPath('.', 'relative-bin');
  const original = process.cwd();
  try {
    const before = resolveCodexRuntime(undefined, undefined, f.dependencies);
    process.chdir(os.tmpdir());
    assert.deepEqual(resolveCodexRuntime(undefined, undefined, f.dependencies), before);
    assert.ok(f.calls.every(call => call.options.cwd === root));
  } finally {
    process.chdir(original);
  }
});

test('自动 PATH 探测有总次数上限，同时始终保留桌面 current 探测机会', () => {
  const f = fixture();
  const directories = Array.from({ length: 20 }, (_, index) => `C:\\candidate-${index}`);
  for (const directory of directories) {
    const binary = f.addRuntime(f.paths.join(directory, 'codex.exe'), '0.170.0');
    f.outputs.set(f.normalize(binary), new Error('ETIMEDOUT'));
  }
  const desktop = f.addRuntime(f.desktopPath(), '0.167.0');
  f.setPath(...directories);
  assert.equal(f.resolve().binary, desktop);
  assert.equal(f.calls.length, 9);
});

test('测试环境没有注入 probe 时，在读取或探测候选之前立即拒绝', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  const f = fixture();
  let reads = 0;
  f.dependencies.fileSystem.readFile = () => { reads++; throw new Error('不应读取'); };
  const { probe: _probe, ...dependencies } = f.dependencies;
  assert.throws(() => resolveCodexRuntime(undefined, f.root, dependencies), /测试禁止探测真实 Codex 进程，请注入 probe/);
  assert.equal(reads, 0);
});
