/**
 * router.js — hash 路由
 * 约定：#/<page>[/<param>]，最多一段参数，防止四层页面嵌套。
 */

const subs = new Set();

export function parseHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [page, param] = raw.split('/');
  return { page: page || 'create', param: param || '' };
}

export function go(page, param = '') {
  const target = `#/${page}${param ? '/' + param : ''}`;
  if (location.hash === target) return;
  location.hash = target;
}

export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }

function fire() {
  const r = parseHash();
  for (const fn of subs) { try { fn(r); } catch (e) { console.warn(e); } }
}

export function start() {
  window.addEventListener('hashchange', fire);
  if (!location.hash) location.hash = '#/create';
  fire();
}

export const current = () => parseHash();
