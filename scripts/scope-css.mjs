// Encierra una hoja de estilos bajo un selector (p. ej. ".guest-studio"): el portal de invitados
// reutiliza los estilos del estudio sin que alteren su página de entrada. Admite reglas, @media
// y @keyframes (que se dejan tal cual); :root, html y body pasan a ser el propio contenedor.

/** Divide por comas de primer nivel (respeta :is(a, b), :has(...), [x="a,b"]). */
function splitSelectors(list) {
  const out = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

export function scopeSelector(selector, scope) {
  const m = selector.match(/^(:root|html|body)\b(.*)$/);
  if (m) return `${scope}${m[2]}`;
  return `${scope} ${selector}`;
}

/** Fin del bloque que abre `{` en `open` (cuenta llaves y salta cadenas y comentarios). */
function blockEnd(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") { i = css.indexOf("*/", i + 2) + 1; continue; }
    if (c === '"' || c === "'") { i = css.indexOf(c, i + 1); continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  throw Error("CSS sin cerrar");
}

export function scopeCss(css, scope) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "", i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    const end = blockEnd(css, open);
    const body = css.slice(open + 1, end);
    if (/^@(keyframes|-webkit-keyframes|font-face)\b/.test(head)) out += `${head}{${body}}\n`;
    else if (/^@(media|supports|container|layer)\b/.test(head)) out += `${head}{\n${scopeCss(body, scope)}}\n`;
    else if (head.startsWith("@")) out += `${head}{${body}}\n`;
    else out += `${splitSelectors(head).map((s) => scopeSelector(s, scope)).join(",")}{${body}}\n`;
    i = end + 1;
  }
  return out;
}
