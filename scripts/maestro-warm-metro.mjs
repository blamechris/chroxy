// A listening Metro server can still be minutes away from serving its first
// native bundle on a cold CI runner. Resolve the URL Expo itself puts in the
// iOS manifest, then consume that bundle before Maestro starts its UI timer.
const originArg = process.argv[2] || 'http://localhost:8081'
const timeoutMs = Number(process.env.MAESTRO_METRO_TIMEOUT_MS || 300000)

function localOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Metro origin must be a plain loopback HTTP origin with an explicit port')
  }
  return url
}

async function warmMetro() {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new Error('MAESTRO_METRO_TIMEOUT_MS must be 1-600000 milliseconds')
  }
  const origin = localOrigin(originArg)
  const controller = new AbortController()
  const started = Date.now()
  const timeout = setTimeout(() => controller.abort(new Error(`iOS Metro bundle exceeded ${timeoutMs}ms`)), timeoutMs)
  const progress = setInterval(() => {
    console.log(`Waiting for iOS Metro bundle (${Math.round((Date.now() - started) / 1000)}s)`)
  }, 30000)
  try {
    const manifest = await fetch(origin, {
      headers: { accept: 'application/expo+json', 'expo-platform': 'ios' },
      redirect: 'manual', signal: controller.signal
    })
    if (!manifest.ok || !manifest.headers.get('content-type')?.includes('application/expo+json')) {
      throw new Error(`iOS Expo manifest returned HTTP ${manifest.status} or an unexpected content type`)
    }
    const data = await manifest.json()
    const asset = data?.launchAsset
    if (asset?.contentType !== 'application/javascript' || typeof asset.url !== 'string') {
      throw new Error('iOS Expo manifest has no JavaScript launch asset')
    }
    const bundleUrl = new URL(asset.url)
    if (bundleUrl.origin !== origin.origin || !bundleUrl.pathname.endsWith('.bundle') ||
      bundleUrl.searchParams.get('platform') !== 'ios' || bundleUrl.hash) {
      throw new Error('iOS Expo launch asset is not a same-origin iOS bundle')
    }
    const bundle = await fetch(bundleUrl, { redirect: 'manual', signal: controller.signal })
    if (!bundle.ok || !bundle.headers.get('content-type')?.includes('javascript') || !bundle.body) {
      throw new Error(`iOS Metro bundle returned HTTP ${bundle.status} or non-JavaScript content`)
    }
    let bytes = 0
    for await (const chunk of bundle.body) bytes += chunk.length
    if (bytes === 0) throw new Error('iOS Metro bundle response was empty')
    console.log(`iOS Metro bundle ready: ${bytes} bytes in ${Math.round((Date.now() - started) / 1000)}s`)
  } finally {
    clearTimeout(timeout)
    clearInterval(progress)
  }
}

warmMetro().catch(error => {
  console.error(`ERROR: Metro warmup failed: ${error.message}`)
  process.exitCode = 1
})
