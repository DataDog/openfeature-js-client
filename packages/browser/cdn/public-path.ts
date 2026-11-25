/**
 * CDN bundle only: the first entry module of `webpack.config.js`. The npm builds do not include it.
 *
 * Sets the base URL of the response signing verifier chunk from the URL of the SDK script. The webpack automatic
 * public path throws at load time when the page gives no script URL, and then `DD_FLAGGING` is never defined. This
 * module never throws. Without a script URL, the chunk URL is relative to the page. If the chunk does not load there,
 * `observe` sends the request without signing and `required` fails closed with `verifier-unavailable`.
 */
// biome-ignore lint/style/useConst: webpack replaces this free variable with its public path at build time.
declare let __webpack_public_path__: string

function scriptDirectory(): string {
  const script = typeof document === 'undefined' ? null : document.currentScript
  const src = script && 'src' in script ? script.src : ''
  if (!src) return ''
  // The same steps as the webpack automatic public path.
  return src
    .replace(/^blob:/, '')
    .replace(/#.*$/, '')
    .replace(/\?.*$/, '')
    .replace(/\/[^/]+$/, '/')
}

__webpack_public_path__ = scriptDirectory()
