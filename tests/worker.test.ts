import { describe, expect, it, vi } from 'vitest'
import { handleRequest, type Env } from '../worker/index'

function createEnv(onAssetRequest?: (request: Request) => void): Env {
  return {
    ASSETS: {
      async fetch(request) {
        onAssetRequest?.(request)
        return new Response('asset', {
          headers: { 'Content-Type': 'text/plain' },
        })
      },
    },
  }
}

describe('RedCoconut edge routing', () => {
  it('passes unrelated tools routes through to the existing origin', async () => {
    const fetchOrigin = vi.fn(async () => new Response('origin'))
    const response = await handleRequest(
      new Request('https://tools.ibukuntaiwo.com/another-tool'),
      createEnv(),
      fetchOrigin,
    )

    expect(await response.text()).toBe('origin')
    expect(fetchOrigin).toHaveBeenCalledOnce()
  })

  it.each(['/redcoconut', '/REdCoCoNuT', '/Redcoconut'])('redirects %s to the canonical path', async (path) => {
    const response = await handleRequest(
      new Request(`https://tools.ibukuntaiwo.com${path}?source=test`),
      createEnv(),
    )

    expect(response.status).toBe(308)
    expect(response.headers.get('Location')).toBe(
      'https://tools.ibukuntaiwo.com/RedCoconut/?source=test',
    )
  })

  it('serves the canonical app root from the static asset binding', async () => {
    let assetPath = ''
    const response = await handleRequest(
      new Request('https://tools.ibukuntaiwo.com/RedCoconut/'),
      createEnv((request) => {
        assetPath = new URL(request.url).pathname
      }),
    )

    expect(assetPath).toBe('/')
    expect(await response.text()).toBe('asset')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
  })

  it('serves fingerprinted assets with long-lived immutable caching', async () => {
    let assetPath = ''
    const response = await handleRequest(
      new Request('https://tools.ibukuntaiwo.com/RedCoconut/assets/index-AbC123.js'),
      createEnv((request) => {
        assetPath = new URL(request.url).pathname
      }),
    )

    expect(assetPath).toBe('/assets/index-AbC123.js')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  it('does not claim paths that merely start with the app name', async () => {
    const fetchOrigin = vi.fn(async () => new Response('origin'))
    await handleRequest(
      new Request('https://tools.ibukuntaiwo.com/redcoconut-oil'),
      createEnv(),
      fetchOrigin,
    )

    expect(fetchOrigin).toHaveBeenCalledOnce()
  })
})
