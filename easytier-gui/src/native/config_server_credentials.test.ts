import { describe, expect, it } from 'vitest'
import { buildConfigServerUrl, splitConfigServerUrl } from './config_server_credentials'

// This is an invented fixture, not a live device token.
const token = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE'

describe('config-server endpoint and management token', () => {
  it('builds the management transport without changing the token', () => {
    const uri = buildConfigServerUrl(' udp://192.0.2.1:22020 ', ` ${token} `)
    expect(uri).toBe(`udp://192.0.2.1:22020/${token}`)
    expect(splitConfigServerUrl(uri)).toEqual({ address: 'udp://192.0.2.1:22020', token })
  })

  it.each(['udp', 'tcp', 'quic'])('migrates an existing complete %s URL', (protocol) => {
    const uri = `${protocol}://vpn.example.test:22020/${token}`
    const fields = splitConfigServerUrl(uri)
    expect(fields).toEqual({ address: `${protocol}://vpn.example.test:22020`, token })
    expect(buildConfigServerUrl(fields.address, fields.token)).toBe(uri)
  })

  it('keeps the original IPv6 endpoint when editing or rotating its token', () => {
    const fields = splitConfigServerUrl(`udp://[2001:db8::1]:22020/${token}`)
    expect(fields.address).toBe('udp://[2001:db8::1]:22020')
    expect(buildConfigServerUrl(fields.address, 'replacement-token')).toBe('udp://[2001:db8::1]:22020/replacement-token')
  })

  it.each(['udp', 'tcp', 'quic'])('migrates the native %s default port explicitly', (protocol) => {
    const fields = splitConfigServerUrl(`${protocol}://vpn.example.test/${token}`)
    expect(fields).toEqual({ address: `${protocol}://vpn.example.test:11010`, token })
    expect(buildConfigServerUrl(fields.address, fields.token)).toBe(`${protocol}://vpn.example.test:11010/${token}`)
  })

  it.each(['ws', 'wss'])('preserves the %s routing prefix and query through edits', (protocol) => {
    const uri = `${protocol}://vpn.example.test/rpc/config/${token}?route=private`
    const fields = splitConfigServerUrl(uri)
    expect(fields.address).toBe(`${protocol}://vpn.example.test/rpc/config?route=private`)
    expect(buildConfigServerUrl(fields.address, fields.token)).toBe(uri)
  })

  it('round-trips opaque tokens with reserved characters without double encoding', () => {
    const opaque = 'opaque/value?part#fragment&percent%'
    const uri = buildConfigServerUrl('wss://vpn.example.test/rpc', opaque)
    expect(splitConfigServerUrl(uri)).toEqual({ address: 'wss://vpn.example.test/rpc', token: opaque })
    const fields = splitConfigServerUrl(uri)
    expect(buildConfigServerUrl(fields.address, fields.token)).toBe(uri)
  })

  it('does not mistake an opaque token for a console login account', () => {
    expect(splitConfigServerUrl('udp://vpn.example.test:22020/external-webhook-token'))
      .toEqual({ address: 'udp://vpn.example.test:22020', token: 'external-webhook-token' })
  })

  it('allows clearing both fields to disconnect management', () => {
    expect(buildConfigServerUrl(' ', ' ')).toBeUndefined()
    expect(splitConfigServerUrl(undefined)).toEqual({ address: '', token: '' })
  })

  it.each([
    ['udp://vpn.example.test:22020', '', 'token_required'],
    ['', token, 'address_required'],
    ['192.0.2.1:22020', token, 'invalid_address'],
    ['https://vpn.example.test', token, 'unsupported_protocol'],
    ['udp://vpn.example.test', token, 'invalid_address'],
    ['tcp://vpn.example.test:0', token, 'invalid_address'],
    [`udp://vpn.example.test:22020/${token}`, token, 'credentials_in_address'],
    ['udp://login:password@vpn.example.test:22020', token, 'credentials_in_address'],
    ['udp://vpn.example.test:22020', 'two tokens', 'invalid_token'],
    ['udp://vpn.example.test:22020', 'bad\u0000token', 'invalid_token'],
    ['udp://vpn.example.test:22020', '.', 'invalid_token'],
    ['wss://vpn.example.test/rpc', '..', 'invalid_token'],
  ])('rejects invalid form input without exposing credentials (%s)', (address, credential, code) => {
    expect(() => buildConfigServerUrl(address, credential)).toThrow(`config-server.${code}`)
    try { buildConfigServerUrl(address, credential) }
    catch (error) {
      expect(String(error)).not.toContain(token)
      expect(String(error)).not.toContain('login:password')
    }
  })

  it.each(['admin', 'not a URL', 'udp://login:password@vpn.example.test:22020/secret', 'file:///secret',
    `wss://vpn.example.test/rpc/${token}/`, `udp://vpn.example.test:22020/${token}/`])
    ('disables invalid saved or bare-account credentials without selecting a server', (saved) => {
      expect(splitConfigServerUrl(saved)).toEqual({ address: '', token: '', legacy: true })
    })
})
