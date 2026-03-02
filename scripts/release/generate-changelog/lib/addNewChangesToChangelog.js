const { readFile } = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')

const emojiNameMap = require('emoji-name-map')

const { getPackageVersion } = require('../../../lib/openfeatureVersion')
const { commandSync } = require('../../../lib/executionUtils')
const { getAffectedPackages } = require('./getAffectedPackages')
const { CHANGELOG_FILE, CONTRIBUTING_FILE, PUBLIC_EMOJI_PRIORITY, INTERNAL_EMOJI_PRIORITY } = require('./constants')

const FIRST_EMOJI_REGEX = /\p{Extended_Pictographic}/u

// Map directory names to package display names for changelog headers
const DIR_TO_DISPLAY_NAME = {
  core: '@datadog/flagging-core',
  browser: '@datadog/openfeature-browser',
  'node-server': '@datadog/openfeature-node-server',
}

/**
 * Determines which packages have changed since the last release and generates
 * changelog sections for each.
 *
 * @param previousContent {string}
 * @returns {Promise<string>}
 */
exports.addNewChangesToChangelog = async (previousContent) => {
  const emojisLegend = await getEmojisLegend()
  const lastTagName = getLastReleaseTagName()

  // Get all changed packages and generate per-package sections
  const changedPackages = getChangedPackageDirectories(lastTagName)
  const sections = []

  for (const dirName of changedPackages) {
    const displayName = DIR_TO_DISPLAY_NAME[dirName] || dirName
    const version = getPackageVersion(dirName)
    const changeLists = getChangeLists(lastTagName, dirName)

    if (changeLists) {
      sections.push(`## ${displayName} v${version}\n\n${changeLists}`)
    }
  }

  // If no per-package changes detected, generate an unscoped section with all changes
  if (sections.length === 0) {
    const changeLists = getChangeLists(lastTagName, null)
    if (changeLists) {
      const highestVersion = getPackageVersion()
      sections.push(`## v${highestVersion}\n\n${changeLists}`)
    }
  }

  const newContent = sections.join('\n\n')

  return `\
# Changelog

${emojisLegend}

---

${newContent}
${previousContent.slice(previousContent.indexOf('\n##'))}`
}

async function getEmojisLegend() {
  const contributing = await readFile(CONTRIBUTING_FILE, { encoding: 'utf-8' })
  let collectLines = false

  const lines = ['> **Legend**']

  for (const line of contributing.split('\n')) {
    if (line.startsWith('### User-facing changes')) {
      collectLines = true
    } else if (collectLines) {
      if (line.startsWith('#')) {
        break
      } else if (line) {
        lines.push('>', `> ${line}`)
      }
    }
  }

  lines.push('>', '> See [Gitmoji](https://gitmoji.dev/) for a guide on the emojis used.')

  return lines.join('\n')
}

/**
 * Get the list of package directory names that have changes since the last tag.
 */
function getChangedPackageDirectories(lastTagName) {
  const commits = commandSync`git log ${lastTagName}..HEAD --pretty=format:"%H %s"`.run().split('\n')
  const packageDirs = new Set()

  commits.forEach((commit) => {
    const spaceIndex = commit.indexOf(' ')
    const hash = commit.slice(0, spaceIndex)
    const message = commit.slice(spaceIndex + 1)
    if (isVersionMessage(message) || isStagingBumpMessage(message)) {
      return
    }
    const affected = getAffectedPackages(hash)
    for (const pkg of affected) {
      packageDirs.add(pkg)
    }
  })

  return Array.from(packageDirs).sort()
}

function getChangeLists(lastTagName, filterPackageDir) {
  const commits = commandSync`git log ${lastTagName}..HEAD --pretty=format:"%H %s"`.run().split('\n')

  const internalChanges = []
  const publicChanges = []

  commits.forEach((commit) => {
    const spaceIndex = commit.indexOf(' ')
    const hash = commit.slice(0, spaceIndex)
    const message = commit.slice(spaceIndex + 1)
    if (isVersionMessage(message) || isStagingBumpMessage(message)) {
      return
    }

    // If filtering by package, skip commits that don't affect it
    if (filterPackageDir) {
      const affected = getAffectedPackages(hash)
      if (affected.length > 0 && !affected.includes(filterPackageDir)) {
        return
      }
    }

    const change = formatChange(hash, message)
    const emoji = findFirstEmoji(change)
    if (PUBLIC_EMOJI_PRIORITY.includes(emoji)) {
      publicChanges.push(change)
    } else {
      internalChanges.push(change)
    }
  })

  const result = [
    formatChangeList('Public Changes', publicChanges, PUBLIC_EMOJI_PRIORITY),
    formatChangeList('Internal Changes', internalChanges, INTERNAL_EMOJI_PRIORITY),
  ]
    .filter(Boolean)
    .join('\n\n')

  return result || ''
}

function getLastReleaseTagName() {
  const changelog = fs.readFileSync(CHANGELOG_FILE, { encoding: 'utf-8' })
  // Match both old-style "## v1.2.3" and new-style "## @datadog/package-name v1.2.3"
  const match = changelog.match(/^## (?:@datadog\/\S+ )?(v\d+\.\d+\.\d+.*)/m)
  if (!match) {
    throw new Error('Could not find the last release version in the changelog')
  }
  console.log(match[1])
  return match[1]
}

function sortByEmojiPriority(a, b, priorityList) {
  const getFirstRelevantEmojiIndex = (text) => {
    const emoji = findFirstEmoji(text)
    return emoji && priorityList.includes(emoji) ? priorityList.indexOf(emoji) : Number.MAX_VALUE
  }
  return getFirstRelevantEmojiIndex(a) - getFirstRelevantEmojiIndex(b)
}

function formatChangeList(title, changes, priority) {
  if (!changes.length) {
    return ''
  }

  const formatedList = changes.sort((a, b) => sortByEmojiPriority(a, b, priority)).join('\n')
  return `**${title}:**\n\n${formatedList}`
}

function formatChange(hash, message) {
  let change = `- ${message}`

  const affectedPackages = getAffectedPackages(hash)
  if (affectedPackages.length > 0) {
    const formattedPackages = affectedPackages
      .map((packageDirectoryName) => `[${packageDirectoryName.toUpperCase()}]`)
      .join(' ')
    change += ` ${formattedPackages}`
  }

  return addLinksToGithubIssues(emojiNameToUnicode(change))
}

function emojiNameToUnicode(message) {
  return message.replace(/:[^:\s]*(?:::[^:\s]*)*:/g, (emoji) => emojiNameMap.get(emoji) || emoji)
}

function addLinksToGithubIssues(message) {
  return message.replace(
    /\(#(\d+)\)/gm,
    (_, id) => `([#${id}](https://github.com/DataDog/openfeature-js-client/pull/${id}))`
  )
}

function findFirstEmoji(message) {
  return message.match(FIRST_EMOJI_REGEX)?.[0]
}

function isVersionMessage(line) {
  return /^v\d+\.\d+\.\d+/.test(line)
}

function isStagingBumpMessage(line) {
  return /Bump staging to staging-\d+/.test(line)
}
