import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
import path from 'node:path';
await viteBuild({configFile:path.resolve('apps/web/vite.config.ts'),root:path.resolve('apps/web')});
await build({entryPoints:{main:'apps/server/src/main.ts','export-worker':'apps/server/src/export-worker.ts'},outdir:'apps/server/dist',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node22',packages:'external',sourcemap:true});
console.log('JDM built. Start with pnpm start, then open http://127.0.0.1:4317');
