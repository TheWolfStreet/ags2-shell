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

const widgetFiles = findScssFiles(resolve(cwd, 'widget'))

console.log(`Found ${widgetFiles.length} widget SCSS files`)

const widgetsIndex = widgetFiles.map(f => {
  const relativePath = f.replace(cwd + '/', '')
  return `@use '../${relativePath}' as *;`
}).join('\n')

const widgetsIndexFile = resolve(cwd, 'style/widgets.scss')
writeFileSync(widgetsIndexFile, widgetsIndex)
console.log(`Generated ${widgetsIndexFile}`)

const inputFile = resolve(cwd, 'style/compile/main.scss')
const outputFile = resolve(cwd, 'style/compile/main.css')

try {
  execSync(`sass ${inputFile} ${outputFile} --style=expanded`, {
    stdio: 'inherit',
    cwd
  })
  console.log(`Compiled -> ${outputFile}`)
} catch (error) {
  console.error("SCSS compilation failed")
  process.exit(1)
}
