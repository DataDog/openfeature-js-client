#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const distDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test-app', 'dist'))

const providerEntrypoints = [
  {
    label: 'DatadogProvider (precomputed fetching)',
    html: 'provider.html',
    expectNoProtobuf: true,
  },
  {
    label: 'DatadogCoreProvider + fetchRulesConfiguration',
    html: 'core-provider.html',
    expectNoProtobuf: false,
  },
]

const smokeEntrypoints = [
  {
    label: 'Provider + Fetch wrapper regression tests',
    html: 'index.html',
    expectNoProtobuf: true,
  },
  {
    label: 'Precomputed parsing/serialization only (no provider)',
    html: 'precomputed.html',
    expectNoProtobuf: true,
  },
  {
    label: 'Rules codec + evaluator + regular provider smoke',
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

  const providerMeasurements = providerEntrypoints.map(measureEntrypoint)
  const smokeMeasurements = smokeEntrypoints.map(measureEntrypoint)
  const measurements = [...providerMeasurements, ...smokeMeasurements]
  const trackingHookMeasurements = trackingHookEntrypoints.map(measureEntrypoint)
  const report = renderMarkdown(providerMeasurements, smokeMeasurements, trackingHookMeasurements)

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

function renderMeasurementTable(measurements) {
  const lines = [
    '| Scenario | HTML | JS Assets | Raw JS | Gzip JS | Protobuf Markers |',
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

  return lines.join('\n')
}

function renderMarkdown(providerMeasurements, smokeMeasurements, trackingHookMeasurements) {
  const lines = [
    '### OpenFeature Browser Provider Bundle Sizes',
    '',
    'Measured from the Vite production output after installing packed `@datadog/flagging-core` and `@datadog/openfeature-browser` tarballs.',
    '',
    'Both scenarios initialize an OpenFeature provider, evaluate a boolean flag, change context, and evaluate again. Telemetry is disabled for DatadogProvider; no tracking hooks are registered for DatadogCoreProvider. DatadogProvider fetches precomputed assignments for each context; DatadogCoreProvider receives rules from fetchRulesConfiguration once and evaluates locally.',
    '',
    'Sizes include OpenFeature and the same small scenario harness. Configuration responses are supplied by Playwright and are not bundled. These are complete scenario JS sizes, not configuration payload sizes or isolated provider/Protobuf costs; the difference between rows is not a decoder-only delta.',
    '',
    renderMeasurementTable(providerMeasurements),
    '',
    '### Additional Smoke Coverage (Not Provider Comparisons)',
    '',
    'These scenarios exercise different APIs and test logic. In particular, the precomputed codec row contains no provider, and the rules codec row combines the evaluator with the regular DatadogProvider, not DatadogCoreProvider.',
    '',
    renderMeasurementTable(smokeMeasurements),
    '',
    'Default and precomputed entrypoints are expected to keep Protobuf-ES out of their bundles. Rules-based entrypoints are expected to include protobuf markers as a positive control. The marker check is a packed-artifact backstop; the source import boundary is enforced by `packages/core/test/entrypoint-boundaries.spec.ts`.',
  ]

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
