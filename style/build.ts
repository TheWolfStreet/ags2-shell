#!/usr/bin/env node

import { writeFileSync, readdirSync, statSync } from "fs"
import { execSync } from "child_process"
import { resolve, join } from "path"

const cwd = process.cwd()

console.log("Building AGS styles...")

function findScssFiles(dir: string): string[] {
  const results: string[] = []
  const items = readdirSync(dir)

  for (const item of items) {
    const fullPath = join(dir, item)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      results.push(...findScssFiles(fullPath))
    } else if (item.endsWith('.scss')) {
      results.push(fullPath)
    }
  }

  return results
}

const scssFiles = [
  ...findScssFiles(resolve(cwd, 'style/mixins')),
  resolve(cwd, 'style/extra.scss'),
  ...findScssFiles(resolve(cwd, 'widget')),
]

console.log(`Found ${scssFiles.length} SCSS files`)

const mainScss = [
  '@use "sass:color";',
  '@use "sass:math";',
  '',
  ...scssFiles.map(f => `@import '${f}';`)
].join('\n')

const tempFile = resolve(cwd, '.ags-build.scss')
const outputFile = resolve(cwd, 'style/main.css')

writeFileSync(tempFile, mainScss)
console.log(`Generated ${tempFile}`)

try {
  execSync(`sass ${tempFile} ${outputFile} --style=expanded --no-source-map`, {
    stdio: 'inherit',
    cwd
  })
  console.log(`Compiled -> ${outputFile}`)
} catch (error) {
  console.error("SCSS compilation failed")
  process.exit(1)
}
