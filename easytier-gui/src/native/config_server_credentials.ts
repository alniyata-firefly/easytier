// Keep the Core wire format unchanged: the final URL path segment is the
// management token. GUI editors expose the endpoint and token separately.
export interface ConfigServerCredentialDraft {
  address: string
  token: string
  legacy?: boolean
}

const supportedProtocols = new Set(['udp:', 'tcp:', 'ws:', 'wss:', 'quic:'])
const websocketProtocols = new Set(['ws:', 'wss:'])

function invalid(code: string): never {
  // Never include the supplied URL or token in an exception or log message.
  throw new Error(`config-server.${code}`)
}

function endpoint(value: string, allowNativeDefaultPort = false): URL {
  let url: URL
  try { url = new URL(value) }
  catch { return invalid('invalid_address') }
  if (!supportedProtocols.has(url.protocol)) invalid('unsupported_protocol')
  if (!url.hostname || url.port === '0') invalid('invalid_address')
  if (!websocketProtocols.has(url.protocol) && !url.port) {
    if (allowNativeDefaultPort) url.port = '11010'
    else invalid('invalid_address')
  }
  if (url.username || url.password) invalid('credentials_in_address')
  if (url.hash) invalid('invalid_address')
  return url
}

export function splitConfigServerUrl(value?: string): ConfigServerCredentialDraft {
  const saved = value?.trim() ?? ''
  if (!saved) return { address: '', token: '' }
  let url: URL
  try { url = endpoint(saved, true) }
  catch {
    // Bare legacy account names must never select the official server. Keep
    // invalid/credential-bearing input out of the visible endpoint field.
    return { address: '', token: '', legacy: true }
  }
  const pathname = url.pathname
  const lastSlash = pathname.lastIndexOf('/')
  let token: string
  try { token = decodeURIComponent(pathname.slice(lastSlash + 1)) }
  catch { return { address: '', token: '', legacy: true } }
  if (!token) return { address: '', token: '', legacy: true }
  if (websocketProtocols.has(url.protocol)) {
    url.pathname = token ? pathname.slice(0, lastSlash) : pathname
  }
  else {
    // Native TCP/UDP/QUIC endpoints do not use a routing path in Core.
    url.pathname = ''
  }
  return { address: url.href, token }
}

export function buildConfigServerUrl(address: string, token: string): string | undefined {
  const server = address.trim()
  const credential = token.trim()
  if (!server && !credential) return undefined
  if (!server) invalid('address_required')
  if (!credential) invalid('token_required')
  if (credential === '.' || credential === '..'
    || /\s|[\u0000-\u001f\u007f]/u.test(credential) || credential.length > 1024)
    invalid('invalid_token')
  const url = endpoint(server)
  if (!websocketProtocols.has(url.protocol) && url.pathname && url.pathname !== '/')
    invalid('credentials_in_address')
  let encoded: string
  try { encoded = encodeURIComponent(credential) }
  catch { return invalid('invalid_token') }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encoded}`
  return url.href
}
