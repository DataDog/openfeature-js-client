#!/usr/bin/env node

const webpack = require('webpack')
const path = require('path')

// Get the webpack config path from command line arguments
const configPath = process.argv[2]
if (!configPath) {
  console.error('Usage: node webpack-runner.js <webpack-config-path>')
  process.exit(1)
}

// Load the webpack config
const configFactory = require(path.resolve(configPath))

// Parse mode from command line arguments
const mode = process.argv.includes('--mode=production') ? 'production' : 'development'

// Call the config function with the mode
const config = configFactory({}, { mode })

// Run webpack
webpack(config, (err, stats) => {
  if (err || stats.hasErrors()) {
    console.error('Webpack build failed:', err || stats.toString())
    process.exit(1)
  }

  console.log('Webpack build completed successfully')
  console.log(
    stats.toString({
      chunks: false,
      colors: true,
    })
  )
})
