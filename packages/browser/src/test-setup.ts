// Mock build environment globals for tests
Object.defineProperty(global, '__BUILD_ENV__SDK_VERSION__', {
  value: '1.0.0-test',
  writable: false,
})