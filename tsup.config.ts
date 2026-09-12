import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/bootstrap.ts',
    plugin: 'src/index.ts',
    'repair-profile': 'src/repair-profile.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  removeNodeProtocol: false,
  noExternal: [/^@diqier\/stratagate(?:\/.*)?$/],
  external: [
    /^@deepseek-ai\//,
    /^\.\/plugin\.js$/,
  ],
})
