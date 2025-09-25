import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'onnxruntime-node': path.resolve(__dirname, 'tests/stubs/onnxruntime-node.ts'),
      pngjs: path.resolve(__dirname, 'tests/stubs/pngjs.ts')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    environment: 'node'
  }
});
