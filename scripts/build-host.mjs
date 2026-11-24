/**
 * Bundle the one Harness API the Host half needs (`defineTool`) into a
 * self-contained module.
 *
 * The plugin is installed into the profile as a link to this directory, so its
 * bare `@deepseek-ai/*` imports do not resolve at runtime; the tool-definition
 * builder is therefore vendored here at build time instead of imported.
 */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

const result = await build({
  stdin: {
    contents: "export { defineTool } from '@deepseek-ai/dsh-tools'\nexport { default as Schema } from '@deepseek-ai/schemastery'\n",
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
})

await mkdir(join(root, 'lib'), { recursive: true })
await (await import('node:fs/promises')).writeFile(join(root, 'lib', 'host-runtime.js'), result.outputFiles[0].text, 'utf8')
console.log(`host runtime: ${(result.outputFiles[0].contents.length / 1024).toFixed(0)} KiB -> lib/host-runtime.js`)
