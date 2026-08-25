/**
 * 极简路由。没用框架是因为这个项目的路由就十来条，
 * 引一个框架换来的是一条依赖和一份升级负担。
 *
 * 路径写法：'/api/ideas/:id/vote'，:id 会进 params。
 */
export function createRouter() {
  const routes = [];

  function add(method, path, handler) {
    const names = [];
    const pattern = new RegExp('^' + path.replace(/:([A-Za-z_]\w*)/g, (_, n) => {
      names.push(n);
      return '([^/]+)';
    }) + '$');
    routes.push({ method, pattern, names, handler, path });
  }

  const api = {
    get:   (p, h) => (add('GET', p, h), api),
    post:  (p, h) => (add('POST', p, h), api),
    patch: (p, h) => (add('PATCH', p, h), api),
    del:   (p, h) => (add('DELETE', p, h), api),

    /** 找到匹配的处理函数。返回 {handler, params} 或 null；
     *  路径匹配但方法不对，返回 { methodNotAllowed: true } */
    match(method, pathname) {
      let pathHit = false;
      for (const r of routes) {
        const m = r.pattern.exec(pathname);
        if (!m) continue;
        pathHit = true;
        if (r.method !== method) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
      return pathHit ? { methodNotAllowed: true } : null;
    },

    list: () => routes.map(r => `${r.method} ${r.path}`),
  };
  return api;
}
