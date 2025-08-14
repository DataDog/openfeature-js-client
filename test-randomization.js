#!/usr/bin/env node

/* eslint-disable no-console */
/**
 * Script to test flag randomization through the OpenFeature SDK
 *
 * Usage: node test-randomization.js <flagKey> <numberOfTests> [flagType] [defaultValue]
 * Example: node test-randomization.js my-flag 1000
 * Example: node test-randomization.js my-flag 1000 boolean true
 * Example: node test-randomization.js my-flag 1000 string "default"
 *
 * Required environment variables:
 *   DD_CLIENT_TOKEN - Datadog client token
 *   DD_APPLICATION_ID - Datadog application ID
 *   DD_API_KEY - Datadog API key
 *   DD_APPLICATION_KEY - Datadog application key
 *
 * Optional environment variables:
 *   DD_SITE - Datadog site (defaults to datadoghq.com)
 *   DD_PROXY_SITE - Proxy URL for flagging configuration requests
 */

require('dotenv').config()

// Setup browser-like environment for Node.js
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
  resources: 'usable',
})

// Set up global browser objects
global.window = dom.window
global.document = dom.window.document
global.navigator = dom.window.navigator
global.location = dom.window.location
global.XMLHttpRequest = dom.window.XMLHttpRequest
global.fetch = global.fetch || dom.window.fetch

const { DatadogProvider } = require('./packages/browser/cjs/index.js')
const { OpenFeature } = require('@openfeature/web-sdk')
const { v4: uuidv4 } = require('uuid')

// Configuration for the provider from environment variables
const PROVIDER_CONFIG = {
  clientToken: process.env.DD_CLIENT_TOKEN,
  applicationId: process.env.DD_APPLICATION_ID,
  apiKey: process.env.DD_API_KEY,
  applicationKey: process.env.DD_APPLICATION_KEY,
  env: 'test',
  site: process.env.DD_SITE || 'datadoghq.com',
  service: 'randomization-test',
  version: '1.0.0',
  enableExposureLogging: false, // Disable for testing to avoid noise
}

// Add proxy configuration if provided
if (process.env.DD_PROXY_SITE) {
  PROVIDER_CONFIG.flaggingProxy = process.env.DD_PROXY_SITE
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function testFlagRandomization(flagKey, numberOfTests, flagType = 'boolean', defaultValue = null) {
  // Set appropriate default value based on flag type if not provided
  if (defaultValue === null) {
    defaultValue = flagType === 'boolean' ? false : 'default'
  } else if (flagType === 'boolean') {
    // Convert string to boolean for boolean flags
    defaultValue = defaultValue === 'true' || defaultValue === true
  }

  console.log(
    `Testing flag randomization for "${flagKey}" with ${numberOfTests} subjects...`,
  )
  console.log(`Flag type: ${flagType}, Default value: ${defaultValue}`)
  console.log('='.repeat(60))

  // Initialize the provider
  const provider = new DatadogProvider(PROVIDER_CONFIG)
  await OpenFeature.setProvider(provider)

  // Get the client
  const client = OpenFeature.getClient()

  // Track results
  const results = new Map()
  let totalTests = 0

  // Generate subjects and test
  for (let i = 0; i < numberOfTests; i++) {
    // Generate pseudo-random subject key
    const subjectKey = `user-${i}-${uuidv4()}`

    try {
      // Set the targeting context
      await OpenFeature.setContext({
        targetingKey: subjectKey,
        user: { id: subjectKey },
        user_type: 'premium',
      })

      // Get flag value based on type
      let flagValue
      if (flagType === 'boolean') {
        flagValue = await client.getBooleanValue(flagKey, defaultValue)
      } else if (flagType === 'string') {
        flagValue = await client.getStringValue(flagKey, defaultValue)
      } else {
        throw new Error(`Unsupported flag type: ${flagType}`)
      }

      // Track the result
      const valueStr = String(flagValue)
      results.set(valueStr, (results.get(valueStr) || 0) + 1)
      totalTests++
    } catch (error) {
      console.error(`Error testing subject ${subjectKey}:`, error.message)
    }

    // Short sleep to avoid hammering the endpoint
    await sleep(10)

    // Progress indicator for large tests
    if (numberOfTests > 100 && i % Math.floor(numberOfTests / 10) === 0) {
      process.stdout.write(
        `Progress: ${Math.round((i / numberOfTests) * 100)}%\r`,
      )
    }
  }

  if (numberOfTests > 100) {
    process.stdout.write('\n') // Clear progress line
  }

  // Display results
  console.log('\nResults:')
  console.log('='.repeat(60))
  console.log(`Total successful tests: ${totalTests}`)
  console.log(`Total unique values: ${results.size}`)
  console.log('')

  // Sort results by count (descending)
  const sortedResults = Array.from(results.entries()).sort(
    (a, b) => b[1] - a[1],
  )

  console.log('Value'.padEnd(20) + 'Count'.padEnd(10) + 'Percentage')
  console.log('-'.repeat(40))

  for (const [value, count] of sortedResults) {
    const percentage = ((count / totalTests) * 100).toFixed(2)
    console.log(
      `${value.padEnd(20)}${count.toString().padEnd(10)}${percentage}%`,
    )
  }

  // Summary statistics
  console.log('')
  console.log('Summary:')
  console.log('-'.repeat(20))

  if (results.size === 1) {
    console.log(
      '⚠️  All subjects received the same value - no randomization detected',
    )
  } else if (flagType === 'boolean' && results.size === 2) {
    // Boolean-specific analysis
    const trueCount = results.get('true') || 0
    const falseCount = results.get('false') || 0
    const truePercentage = ((trueCount / totalTests) * 100).toFixed(1)
    const falsePercentage = ((falseCount / totalTests) * 100).toFixed(1)

    console.log(
      `📊 Boolean split: ${truePercentage}% true, ${falsePercentage}% false`,
    )

    const deviation = Math.abs(0.5 - trueCount / totalTests) * 100
    console.log(`📈 Deviation from 50/50 split: ${deviation.toFixed(2)}%`)

    if (deviation < 5) {
      console.log('✅ Good randomization (< 5% deviation)')
    } else if (deviation < 10) {
      console.log('⚠️  Moderate randomization (5-10% deviation)')
    } else {
      console.log('❌ Poor randomization (> 10% deviation)')
    }
  } else {
    // General analysis for string flags or multiple values
    const mostCommonValue = sortedResults[0]
    const dominantPercentage = ((mostCommonValue[1] / totalTests) * 100).toFixed(1)
    
    console.log(`📊 Values distributed across ${results.size} different outcomes`)
    console.log(`📈 Most common value: "${mostCommonValue[0]}" (${dominantPercentage}%)`)
    
    if (results.size >= 2) {
      const evenDistribution = 100 / results.size
      const deviation = Math.abs(evenDistribution - dominantPercentage)
      
      if (deviation < 10) {
        console.log('✅ Good distribution - values are fairly spread')
      } else if (deviation < 25) {
        console.log('⚠️  Moderate distribution - some bias detected')
      } else {
        console.log('❌ Poor distribution - heavily skewed toward one value')
      }
    }
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2)

  if (args.length < 2 || args.length > 4) {
    console.error('Usage: node test-randomization.js <flagKey> <numberOfTests> [flagType] [defaultValue]')
    console.error('Examples:')
    console.error('  node test-randomization.js my-flag 1000')
    console.error('  node test-randomization.js my-flag 1000 boolean true')
    console.error('  node test-randomization.js my-flag 1000 string "default"')
    console.error('')
    console.error('Required environment variables:')
    console.error('  DD_CLIENT_TOKEN - Datadog client token')
    console.error('  DD_APPLICATION_ID - Datadog application ID')
    console.error('  DD_API_KEY - Datadog API key')
    console.error('  DD_APPLICATION_KEY - Datadog application key')
    console.error('')
    console.error('Optional environment variables:')
    console.error('  DD_SITE - Datadog site (defaults to datadoghq.com)')
    console.error('  DD_PROXY_SITE - Proxy URL for flagging configuration requests')
    console.error('')
    console.error('You can set these in a .env file in the project root.')
    process.exit(1)
  }

  const flagKey = args[0]
  const numberOfTests = parseInt(args[1], 10)
  const flagType = args[2] || 'boolean'
  const defaultValue = args[3] || null

  // Validate flag type
  if (!['boolean', 'string'].includes(flagType)) {
    console.error(`Error: Unsupported flag type "${flagType}". Supported types: boolean, string`)
    process.exit(1)
  }

  if (isNaN(numberOfTests) || numberOfTests <= 0) {
    console.error('Error: numberOfTests must be a positive integer')
    process.exit(1)
  }

  if (numberOfTests > 10000) {
    console.error(
      'Error: numberOfTests too large (max 10,000 to avoid endpoint stress)',
    )
    process.exit(1)
  }

  // Check for required environment variables
  const requiredEnvVars = [
    'DD_CLIENT_TOKEN',
    'DD_APPLICATION_ID',
    'DD_API_KEY',
    'DD_APPLICATION_KEY',
  ]
  const missingVars = requiredEnvVars.filter((varName) => !process.env[varName])

  if (missingVars.length > 0) {
    console.error('Error: Missing required environment variables:')
    missingVars.forEach((varName) => console.error(`  ${varName}`))
    console.error('\nYou can set these in a .env file in the project root.')
    process.exit(1)
  }

  try {
    await testFlagRandomization(flagKey, numberOfTests, flagType, defaultValue)
  } catch (error) {
    console.error('Error running randomization test:', error.message)
    process.exit(1)
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nTest interrupted by user')
  process.exit(0)
})

// Run the script
if (require.main === module) {
  main().catch(console.error)
}

module.exports = { testFlagRandomization }

