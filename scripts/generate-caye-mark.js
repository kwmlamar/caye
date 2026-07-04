#!/usr/bin/env node
const path = require('path')
const sharp = require('sharp')

const svgPath = path.resolve(__dirname, '../public/caye-mark.svg')
const outDir = path.resolve(__dirname, '../public')
const sizes = [512, 1024]

async function generate() {
  try {
    for (const s of sizes) {
      const out = path.join(outDir, `caye-mark-${s}.png`)
      await sharp(svgPath)
        .resize(s, s, { fit: 'contain' })
        .png({ quality: 100 })
        .toFile(out)
      console.log(`Wrote ${out}`)
    }
    console.log('All images generated.')
  } catch (err) {
    console.error('Error generating images:', err)
    process.exitCode = 1
  }
}

generate()
