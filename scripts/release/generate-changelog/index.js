const { command } = require('../../lib/executionUtils')
const { modifyFile } = require('../../lib/filesUtils')
const { addNewChangesToChangelog } = require('./lib/addNewChangesToChangelog')
const { CHANGELOG_FILE } = require('./lib/constants')

const { runMain } = require('../../lib/executionUtils')

runMain(async () => {
  if (!process.env.EDITOR) {
    console.error('Please configure your environment variable EDITOR')
    process.exit(1)
  }

  await modifyFile(CHANGELOG_FILE, addNewChangesToChangelog)

  const { spawn } = require('child_process')
  spawn(process.env.EDITOR, [CHANGELOG_FILE], { stdio: 'inherit' })

  command`yarn run prettier --write ${CHANGELOG_FILE}`.run()

  command`git add ${CHANGELOG_FILE}`.run()
}) 