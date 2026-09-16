import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localExports } from './local-export';
import { localSamples } from './sample-catalog';
import { localCleanup } from './local-cleanup';
export default defineConfig({
  plugins: [react(), localExports(), localSamples(), localCleanup()],
  server: {
    host: '127.0.0.1', port: 4328, strictPort: true,
    // Artwork can be open in desktop design software while the app is running.
    // It is read on demand; watching locked Windows image files can stop Vite.
    watch: { ignored: ['**/output/**', '**/sample/**', '**/samples/**', '**/*.{bmp,BMP,png,PNG}'] },
  },
  build: { target: 'es2022' },
});
