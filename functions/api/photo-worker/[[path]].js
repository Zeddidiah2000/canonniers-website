export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    const targetPath = url.pathname.replace('/api/photo-worker', '');
    const targetUrl = `https://photo-worker.chisholm2000.workers.dev${targetPath}${url.search}`;

    // Clone headers and strip Host (would conflict with upstream)
    const headers = new Headers(context.request.headers);
    headers.delete('host');

    // CF_Authorization cookie IS the CF Access JWT. Forward it as the assertion
    // header so photo-worker can do trust-without-verify identity extraction.
    const cookie = context.request.headers.get('cookie') || '';
    const cfJwtMatch = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    if (cfJwtMatch) {
      headers.set('CF-Access-Jwt-Assertion', decodeURIComponent(cfJwtMatch[1]));
    }

    const init = {
      method:  context.request.method,
      headers,
    };

    if (!['GET', 'HEAD'].includes(context.request.method) && context.request.body !== null) {
      init.body   = context.request.body;
      init.duplex = 'half';
    }

    return await fetch(targetUrl, init);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'proxy failed', detail: String(e) }), {
      status:  502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
