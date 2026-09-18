#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const distDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test-app', 'dist'))

const entrypoints = [
  {
    label: 'root provider smoke',
    html: 'index.html',
    expectNoProtobuf: true,
  },
  {
    label: 'precomputed configuration',
    html: 'precomputed.html',
    expectNoProtobuf: true,
  },
  {
    label: 'rules-based configuration',
    html: 'protobuf.html',
    expectNoProtobuf: false,
  },
]

const trackingHookEntrypoints = [
  {
    label: 'tracking hook baseline',
    html: 'tracking-baseline.html',
    baseline: true,
  },
  {
    label: 'exposure logging hook',
    html: 'tracking-exposure.html',
  },
  {
    label: 'evaluation logging hook',
    html: 'tracking-evaluation.html',
  },
  {
    label: 'RUM tracking hook',
    html: 'tracking-rum.html',
  },
  {
    label: 'all tracking hooks',
    html: 'tracking-all.html',
  },
]

const protobufMarkers = ['datadog.ffe.flagging.ufc.v1', 'google.protobuf']

function main() {
  if (!fs.existsSync(distDirectory)) {
    throw new Error(`Build output not found: ${distDirectory}`)
  }

  const measurements = entrypoints.map(measureEntrypoint)
  const trackingHookMeasurements = trackingHookEntrypoints.map(measureEntrypoint)
  const report = renderMarkdown(measurements, trackingHookMeasurements)

  console.log(report)

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  }

  if (process.env.ENTRYPOINT_BUNDLE_SIZE_REPORT_PATH) {
    const reportPath = path.resolve(process.env.ENTRYPOINT_BUNDLE_SIZE_REPORT_PATH)
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, `${report}\n`)
  }

  const prohibitedProtobufMarkers = measurements.filter(
    (measurement) => measurement.expectNoProtobuf && measurement.hasProtobufMarker
  )
  if (prohibitedProtobufMarkers.length > 0) {
    const labels = prohibitedProtobufMarkers.map((measurement) => measurement.label).join(', ')
    throw new Error(`Default/precomputed entrypoints include protobuf markers: ${labels}`)
  }

  const missingProtobufMarkers = measurements.filter(
    (measurement) => !measurement.expectNoProtobuf && !measurement.hasProtobufMarker
  )
  if (missingProtobufMarkers.length > 0) {
    const labels = missingProtobufMarkers.map((measurement) => measurement.label).join(', ')
    throw new Error(`Rules-based entrypoints are missing protobuf markers: ${labels}`)
  }
}

function measureEntrypoint(entrypoint) {
  const htmlPath = path.join(distDirectory, entrypoint.html)
  const html = fs.readFileSync(htmlPath, 'utf8')
  const assets = collectJavascriptAssets(html).map((asset) => path.join(distDirectory, asset))
  const uniqueAssets = [...new Set(assets)]

  const assetMeasurements = uniqueAssets.map((assetPath) => {
    const content = fs.readFileSync(assetPath)
    return {
      path: assetPath,
      rawBytes: content.length,
      gzipBytes: zlib.gzipSync(content).length,
      content,
    }
  })

  return {
    ...entrypoint,
    assets: assetMeasurements,
    rawBytes: assetMeasurements.reduce((sum, asset) => sum + asset.rawBytes, 0),
    gzipBytes: assetMeasurements.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    hasProtobufMarker: assetMeasurements.some((asset) =>
      protobufMarkers.some((marker) => asset.content.includes(marker))
    ),
  }
}

function collectJavascriptAssets(html) {
  const assets = []
  const assetPattern = /(?:src|href)="([^"]+\.js)"/g
  let match = assetPattern.exec(html)
  while (match) {
    assets.push(match[1].replace(/^\//, ''))
    match = assetPattern.exec(html)
  }
  return assets
}

function renderMarkdown(measurements, trackingHookMeasurements) {
  const lines = [
    '### OpenFeature Browser Entrypoint Bundle Sizes',
    '',
    'Measured from the Vite production output after installing packed `@datadog/flagging-core` and `@datadog/openfeature-browser` tarballs.',
    '',
    '| Entrypoint | HTML | JS Assets | Raw JS | Gzip JS | Protobuf Markers |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ]

  for (const measurement of measurements) {
    lines.push(
      [
        measurement.label,
        `\`${measurement.html}\``,
        measurement.assets.length.toString(),
        formatBytes(measurement.rawBytes),
        formatBytes(measurement.gzipBytes),
        measurement.hasProtobufMarker ? 'yes' : 'no',
      ]
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |')
    )
  }

  lines.push(
    '',
    'Default and precomputed entrypoints are expected to keep Protobuf-ES out of their bundles. Rules-based entrypoints are expected to include protobuf markers as a positive control. The marker check is a packed-artifact backstop; the source import boundary is enforced by `packages/core/test/entrypoint-boundaries.spec.ts`.'
  )

  lines.push('', '### OpenFeature Browser Tracking Hook Bundle Sizes', '')
  lines.push(
    'Synthetic entrypoints import and call tracking hook factories from the packed `@datadog/openfeature-browser/rules-based` ESM package. Deltas are measured against the no-hook baseline from the same Vite production build.'
  )
  lines.push(
    '',
    '| Scenario | HTML | JS Assets | Raw JS | Raw Δ | Gzip JS | Gzip Δ |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |'
  )

  const baseline = trackingHookMeasurements.find((measurement) => measurement.baseline)
  if (!baseline) {
    throw new Error('Tracking hook bundle-size baseline was not measured')
  }

  for (const measurement of trackingHookMeasurements) {
    lines.push(
      [
        measurement.label,
        `\`${measurement.html}\``,
        measurement.assets.length.toString(),
        formatBytes(measurement.rawBytes),
        formatByteDelta(measurement.rawBytes - baseline.rawBytes),
        formatBytes(measurement.gzipBytes),
        formatByteDelta(measurement.gzipBytes - baseline.gzipBytes),
      ]
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |')
    )
  }

  return lines.join('\n')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function formatByteDelta(bytes) {
  if (bytes === 0) return '0 B'
  return `${bytes > 0 ? '+' : '-'}${formatBytes(Math.abs(bytes))}`
}

main()
