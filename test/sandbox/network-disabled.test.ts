import { afterEach, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import type { SandboxRuntimeConfig } from '../../src/sandbox/sandbox-config.js'
import { spawnAsync } from '../helpers/spawn.js'
import { isLinux, isMacOS } from '../helpers/platform.js'

const supported = isMacOS || isLinux

function disabledConfig(): SandboxRuntimeConfig {
  return {
    network: {
      disabled: true,
      // Keep the standard settings shape. These policy fields are ignored
      // while disabled and become usable again after reset()+initialize().
      allowedDomains: [],
      deniedDomains: [],
      allowAllUnixSockets: false,
    },
    filesystem: {
      denyRead: [],
      allowWrite: [],
      denyWrite: [],
    },
  }
}

describe.if(supported)('network.disabled', () => {
  afterEach(async () => {
    await SandboxManager.reset()
  })

  it('initializes without starting proxy or bridge infrastructure', async () => {
    await SandboxManager.initialize(disabledConfig())

    expect(SandboxManager.getProxyPort()).toBeUndefined()
    expect(SandboxManager.getSocksProxyPort()).toBeUndefined()
    expect(SandboxManager.getLinuxHttpSocketPath()).toBeUndefined()
    expect(SandboxManager.getLinuxSocksSocketPath()).toBeUndefined()
    expect(SandboxManager.getProxyAuthToken()).toBeUndefined()
    expect(SandboxManager.getNetworkRestrictionConfig()).toEqual({})
  })

  it('keeps filesystem sandboxing while omitting every network mechanism', async () => {
    await SandboxManager.initialize(disabledConfig())

    const command = 'printf network-disabled'
    const wrapped = await SandboxManager.wrapWithSandbox(command)

    // The filesystem allow-only policy still requires a native sandbox.
    expect(wrapped).not.toBe(command)
    // No host proxy environment and no Linux network namespace isolation.
    expect(wrapped).not.toContain('HTTP_PROXY')
    expect(wrapped).not.toContain('HTTPS_PROXY')
    expect(wrapped).not.toContain('ALL_PROXY')
    expect(wrapped).not.toContain('--unshare-net')
    // Unix sockets are part of unrestricted networking, so the independent
    // Linux seccomp wrapper must also be absent.
    expect(wrapped).not.toContain('apply-seccomp')
    if (isMacOS) {
      expect(wrapped).toContain('(allow network*)')
    }

    const deniedWrite = join(
      tmpdir(),
      `srt-network-disabled-denied-${process.pid}`,
    )
    rmSync(deniedWrite, { force: true })
    const deniedWriteCommand = await SandboxManager.wrapWithSandbox(
      `touch ${deniedWrite}`,
    )
    const result = await spawnAsync(deniedWriteCommand, {
      shell: true,
      timeout: 5000,
    })
    expect(result.status).not.toBe(0)
    expect(existsSync(deniedWrite)).toBe(false)
  })

  it('reaches the host network directly without an SRT proxy', async () => {
    const upstream = createServer((_req, res) => res.end('direct-network-ok'))
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))

    try {
      await SandboxManager.initialize(disabledConfig())
      const port = (upstream.address() as AddressInfo).port
      const wrapped = await SandboxManager.wrapWithSandbox(
        `curl --silent --show-error --fail --noproxy '*' http://127.0.0.1:${port}`,
      )
      const result = await spawnAsync(wrapped, {
        shell: true,
        timeout: 5000,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('direct-network-ok')
    } finally {
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })

  it('rejects changing enforcement per call when the session has no proxy', async () => {
    await SandboxManager.initialize(disabledConfig())

    await expect(
      SandboxManager.wrapWithSandbox('true', undefined, {
        network: {
          disabled: false,
          allowedDomains: [],
          deniedDomains: [],
        },
      }),
    ).rejects.toThrow('session-wide')
  })

  it('requires reinitialization when updateConfig toggles disabled', async () => {
    const initial = disabledConfig()
    await SandboxManager.initialize(initial)

    expect(() =>
      SandboxManager.updateConfig({
        ...initial,
        network: { ...initial.network, disabled: false },
      }),
    ).toThrow('session-wide')
  })
})
