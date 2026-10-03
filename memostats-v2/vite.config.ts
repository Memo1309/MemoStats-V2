import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// Build stamp shown in LOGURI so a vehicle test can always name the exact build it ran.
const buildTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
