const { spawn } = require('child_process')

function runMain(main) {
  Promise.resolve()
    // The main function can be either synchronous or asynchronous, so let's wrap it in an async
    // callback that will catch both thrown errors and rejected promises
    .then(() => main())
    .catch((error) => {
      printError('\nScript exited with error:', error)
      process.exit(1)
    })
}

const resetColor = '\x1b[0m'

function printError(...params) {
  const redColor = '\x1b[31;1m'
  console.log(redColor, ...params, resetColor)
}

function printLog(...params) {
  const greenColor = '\x1b[32;1m'
  console.log(greenColor, ...params, resetColor)
}

function command(strings, ...values) {
  const command = strings.reduce((result, string, index) => {
    return result + string + (values[index] || '')
  }, '')

  return {
    run() {
      return new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: 'inherit' })
        child.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`Command failed with exit code ${code}`))
          }
        })
      })
    }
  }
}

async function fetchHandlingError(url, options) {
  const response = await fetch(url, options)
  if (!response.ok) {
    const error = new Error(`HTTP Error Response: ${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }

  return response
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
  runMain,
  command,
  printError,
  printLog,
  fetchHandlingError,
  timeout
} 