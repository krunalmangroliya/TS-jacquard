import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { MachineProfile, Master, RuleConfig, SizeInput } from '../../core/src/types';

export interface BrowserDeterminismCase {
  name: string;
  master: Master;
  profile: MachineProfile;
  sizeInput: SizeInput;
  rules: RuleConfig;
  expectedBmp: Uint8Array;
}

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export async function installedBrowser(): Promise<{ executablePath: string; name: string }> {
  const candidates: { executablePath: string; name: string }[] = [];
  if (process.platform === 'win32') {
    for (const root of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter((root): root is string => !!root)) {
      candidates.push({ executablePath: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'Microsoft Edge' });
      candidates.push({ executablePath: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Google Chrome' });
    }
  } else if (process.platform === 'darwin') {
    candidates.push({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', name: 'Google Chrome' });
    candidates.push({ executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', name: 'Microsoft Edge' });
  } else {
    for (const executablePath of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge']) candidates.push({ executablePath, name: path.basename(executablePath) });
  }
  candidates.push({ executablePath: chromium.executablePath(), name: 'Playwright Chromium' });
  for (const candidate of candidates) {
    try { await access(candidate.executablePath); return candidate; } catch { /* Try the next installed browser; never download implicitly. */ }
  }
  throw new Error('Browser determinism requires an installed Microsoft Edge, Google Chrome, or Playwright Chromium executable. No browser was downloaded.');
}

/** Compare complete BMP bytes from Node with the same pure core running in a real browser Web Worker. */
export async function verifyBrowserDeterminism(cases: BrowserDeterminismCase[]): Promise<{ checked: number; browser: string }> {
  if (cases.length === 0) return { checked: 0, browser: 'Not launched (no cases)' };
  const cacheDir = path.join(projectRoot, '.cache', 'browser-check');
  await mkdir(cacheDir, { recursive: true });
  const bundled = await build({
    stdin: {
      contents: `
        import { materializeGeometry } from './packages/core/src/materialize';
        import { render } from './packages/core/src/render';
        import { resolveSize } from './packages/core/src/size';
        import { encodeBmp } from './packages/core/src/bmp';
        self.onmessage = ({ data }) => {
          try {
            const { master, profile, sizeInput, rules } = data;
            const topology = materializeGeometry(master);
            const size = resolveSize(master.bounds, profile, sizeInput);
            const result = render(topology.geometry, topology.faces, master.bounds, master.palette, size.widthPx, size.heightPx, rules, [], master.repeat, master.raster);
            const bmp = encodeBmp(result.grid, size.widthPx, size.heightPx, master.palette, profile);
            self.postMessage({ ok: true, buffer: bmp.buffer }, [bmp.buffer]);
          } catch (error) {
            self.postMessage({ ok: false, error: error instanceof Error ? error.stack || error.message : String(error) });
          }
        };
      `,
      resolveDir: projectRoot, sourcefile: 'browser-check-worker.ts', loader: 'ts',
    },
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, metafile: true, sourcemap: false,
  });
  const workerSource = bundled.outputFiles[0].text;
  const dependencies = Object.keys(bundled.metafile?.inputs ?? {});
  if (dependencies.some(dependency => /node_modules|packages\/eval/.test(dependency))) throw new Error(`Worker unexpectedly contains runtime dependencies outside pure core: ${dependencies.join(', ')}`);
  await writeFile(path.join(cacheDir, 'worker.js'), workerSource, 'utf8');
  const installed = await installedBrowser();
  let browser: Browser;
  try { browser = await chromium.launch({ executablePath: installed.executablePath, headless: true }); }
  catch (error) { throw new Error(`Could not launch installed ${installed.name} for browser determinism: ${error instanceof Error ? error.message : String(error)}`); }
  const comparisons: { name: string; bytes: number; sha256: string }[] = [];
  try {
    const page = await browser.newPage();
    for (const testCase of cases) {
      const { expectedBmp, name, ...payload } = testCase;
      const actualBase64 = await page.evaluate(({ workerSource, payload }) => new Promise<string>((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
        const worker = new Worker(url);
        const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error('Core worker timed out after 60 seconds.')); }, 60_000);
        worker.onerror = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); reject(new Error(event.message)); };
        worker.onmessage = event => {
          clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url);
          if (!event.data.ok) { reject(new Error(event.data.error)); return; }
          const bytes = new Uint8Array(event.data.buffer), chunks: string[] = [];
          for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
          resolve(btoa(chunks.join('')));
        };
        worker.postMessage(payload);
      }), { workerSource, payload }).catch(error => { throw new Error(`Browser worker failed for ${name}: ${error instanceof Error ? error.message : String(error)}`); });
      const actual = new Uint8Array(Buffer.from(actualBase64, 'base64'));
      const expectedHash = digest(expectedBmp), actualHash = digest(actual);
      let mismatch = -1;
      for (let i = 0; i < Math.min(actual.length, expectedBmp.length); i++) if (actual[i] !== expectedBmp[i]) { mismatch = i; break; }
      if (mismatch >= 0 || actual.length !== expectedBmp.length) {
        if (mismatch < 0) mismatch = Math.min(actual.length, expectedBmp.length);
        throw new Error(`Browser determinism mismatch in ${name} at BMP byte ${mismatch}: Node=${expectedBmp[mismatch] ?? 'EOF'}, browser=${actual[mismatch] ?? 'EOF'}. Node ${expectedBmp.length} bytes sha256=${expectedHash}; browser ${actual.length} bytes sha256=${actualHash}.`);
      }
      comparisons.push({ name, bytes: actual.length, sha256: actualHash });
    }
    const browserName = `${installed.name} ${browser.version()}`;
    await writeFile(path.join(cacheDir, 'results.json'), `${JSON.stringify({ browser: browserName, checked: comparisons.length, comparisons }, null, 2)}\n`, 'utf8');
    return { checked: comparisons.length, browser: browserName };
  } finally { await browser.close(); }
}
