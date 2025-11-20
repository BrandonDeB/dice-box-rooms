import { resolve } from "path"
import { defineConfig } from 'vite'
// vite.config.js

const root = resolve(__dirname, 'src')
const outDir = resolve(__dirname, 'dist')

export default defineConfig({
  root,
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'DiceBox',
      fileName: (format) => `dice-box-threejs.${format}.js`,
      formats: ['es', 'umd']
    },
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        exports: 'named'
      }
    }
  }
})
