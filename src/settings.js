/** Configure the row presentation and expose facts through the host trust fence. */
export const CONFIG_PATH = '/better-goal/api/config'

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

export function handleConfig(ctx, status, req, res) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') {
    sendJson(res, 503, { code: 'CONFIG_UNAVAILABLE', message: 'Host connection trust fence is unavailable' })
    return
  }
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    sendJson(res, rejection, { code: 'UNTRUSTED_REQUEST', message: 'Host connection rejected this request' })
    return
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET' })
    return
  }
  sendJson(res, 200, status())
}

export function mountSettings(ctx, status) {
  ctx.inject(['settings'], (inner) => {
    const dispose = inner.settings.configure({ auto: false }, ctx.fiber)
    inner.effect(() => dispose, 'better-goal: settings page')
  })
  ctx.inject(['webServer', 'connection'], (inner) => {
    if (typeof inner.connection.requestRejection !== 'function') return
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (req, res) => handleConfig(inner, status, req, res),
    }), 'better-goal: configuration status')
  })
}
