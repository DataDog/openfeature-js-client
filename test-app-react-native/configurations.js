const rules = {
  version: 1,
  rules: {
    response:
      'EgRwcm9kGigKDGJyb3dzZXItZmxhZxIYEAQaAigBIhAKCmFsbG9jYXRpb24iAiADGigKDGludGVnZXItZmxhZxIYEAIaAhgqIhAKCmFsbG9jYXRpb24iAiADKgJvbg==',
  },
}

const precomputed = {
  version: 1,
  precomputed: {
    context: { targetingKey: 'static-user' },
    response: JSON.stringify({
      data: {
        attributes: {
          createdAt: 0,
          flags: {
            'precomputed-flag': {
              allocationKey: 'allocation',
              variationKey: 'on',
              variationType: 'boolean',
              variationValue: true,
              reason: 'STATIC',
              doLog: false,
            },
          },
        },
      },
    }),
  },
}

module.exports = { rules, precomputed }
