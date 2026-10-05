#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const COMMENT_MARKER = '<!-- datadog-openfeature-entrypoint-bundle-sizes -->'

const bundleDirectories = [
  'packages/browser/',
  'packages/core/',
  'test-app/',
  'scripts/build/',
  'scripts/lib/',
  '.yarn/',
]
const bundleFiles = new Set([
  'scripts/webpack-runner.js',
  'scripts/test-package-install.sh',
  'scripts/report-entrypoint-bundle-sizes.js',
  'scripts/comment-entrypoint-bundle-sizes.js',
  'package.json',
  'yarn.lock',
  'lerna.json',
  '.yarnrc.yml',
  '.npmrc',
  '.github/workflows/ci.yaml',
])

function isBundleReportPath(filename) {
  if (!filename || /\.(md|markdown)$/i.test(filename)) return false

  return (
    bundleDirectories.some((directory) => filename.startsWith(directory)) ||
    bundleFiles.has(filename) ||
    /^(tsconfig[^/]*\.json|webpack[^/]*\.js)$/.test(filename)
  )
}

async function hasBundleRelevantChanges(request, pullRequestPath) {
  // GitHub caps PR file listings at 3,000 files. At the cap, publish conservatively.
  for (let page = 1; page <= 30; page++) {
    const files = await request(`${pullRequestPath}/files?per_page=100&page=${page}`)
    if (files.some((file) => isBundleReportPath(file.filename) || isBundleReportPath(file.previous_filename))) {
      return true
    }
    if (files.length < 100) return false
  }

  console.log('PR file listing reached the GitHub limit; publishing the bundle-size report conservatively.')
  return true
}

async function main() {
  const reportPath = process.argv[2] || process.env.ENTRYPOINT_BUNDLE_SIZE_REPORT_PATH

  if (!reportPath) {
    console.log('Skipping entrypoint bundle-size PR comment: report path was not provided.')
    return
  }

  const resolvedReportPath = path.resolve(reportPath)
  if (!fs.existsSync(resolvedReportPath)) {
    console.log(`Skipping entrypoint bundle-size PR comment: report was not found at ${resolvedReportPath}.`)
    return
  }

  const report = fs.readFileSync(resolvedReportPath, 'utf8').trim()
  if (!report) {
    console.log(`Skipping entrypoint bundle-size PR comment: report at ${resolvedReportPath} is empty.`)
    return
  }

  const token = process.env.GITHUB_TOKEN
  const repository = process.env.GITHUB_REPOSITORY
  const eventPath = process.env.GITHUB_EVENT_PATH

  if (!token || !repository || !eventPath) {
    console.log('Skipping entrypoint bundle-size PR comment: GitHub Actions pull request context is unavailable.')
    return
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
  if (!event.pull_request) {
    console.log('Skipping entrypoint bundle-size PR comment: current event is not a pull request.')
    return
  }

  const [owner, repo] = repository.split('/')
  const issueNumber = event.pull_request.number
  const body = `${COMMENT_MARKER}\n${report}\n\n_This report shows current PR artifact sizes only; it does not compare against the base branch._`
  const request = createGithubRequest(token)
  if (!(await hasBundleRelevantChanges(request, `/repos/${owner}/${repo}/pulls/${issueNumber}`))) {
    console.log('Skipping entrypoint bundle-size PR comment: no bundle-relevant paths changed in this pull request.')
    return
  }

  const comments = await request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`)
  const existingComment = comments.find(
    (comment) => typeof comment.body === 'string' && comment.body.includes(COMMENT_MARKER)
  )

  if (existingComment) {
    await request(`/repos/${owner}/${repo}/issues/comments/${existingComment.id}`, {
      method: 'PATCH',
      body: { body },
    })
    console.log(`Updated entrypoint bundle-size comment on pull request #${issueNumber}.`)
    return
  }

  await request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: { body },
  })
  console.log(`Created entrypoint bundle-size comment on pull request #${issueNumber}.`)
}

function createGithubRequest(token) {
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com'

  return async function githubRequest(route, options = {}) {
    const response = await fetch(`${apiUrl}${route}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'openfeature-entrypoint-bundle-size-report',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })

    if (!response.ok) {
      const responseBody = await response.text()
      throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}\n${responseBody}`)
    }

    if (response.status === 204) {
      return undefined
    }

    return response.json()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { main, isBundleReportPath, hasBundleRelevantChanges }
