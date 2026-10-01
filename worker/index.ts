const APP_PATH = '/RedCoconut'
const APP_PATH_PATTERN = /^\/redcoconut(?=\/|$)/i
const HASHED_ASSET_PATTERN = /^\/assets\/.*-[A-Za-z0-9_-]+\.(?:css|js)$/

type AssetsBinding = {
  fetch(request: Request): Promise<Response>
}

export type Env = {
  ASSETS: AssetsBinding
}

type OriginFetch = (request: Request) => Promise<Response>

function canonicalUrl(url: URL, matchedPath: string): URL | null {
  const needsTrailingSlash = url.pathname.length === matchedPath.length
  const hasCanonicalCase = matchedPath === APP_PATH

  if (hasCanonicalCase && !needsTrailingSlash) {
    return null
  }

  const canonical = new URL(url)
  canonical.pathname = `${APP_PATH}${url.pathname.slice(matchedPath.length)}${needsTrailingSlash ? '/' : ''}`
  return canonical
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetchOrigin: OriginFetch = fetch,
): Promise<Response> {
  const url = new URL(request.url)
  const match = url.pathname.match(APP_PATH_PATTERN)

  if (!match) {
    return fetchOrigin(request)
  }

  const redirectUrl = canonicalUrl(url, match[0])
  if (redirectUrl) {
    return Response.redirect(redirectUrl.toString(), 308)
  }

  const assetUrl = new URL(url)
  assetUrl.pathname = url.pathname.slice(APP_PATH.length) || '/'
  const assetRequest = new Request(assetUrl, request)
  const assetResponse = await env.ASSETS.fetch(assetRequest)
  const headers = new Headers(assetResponse.headers)

  headers.set('X-Content-Type-Options', 'nosniff')
  if (HASHED_ASSET_PATTERN.test(assetUrl.pathname)) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  } else if (assetUrl.pathname === '/' || assetUrl.pathname.endsWith('.html')) {
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate')
  }

  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  })
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env)
  },
}
