// Browser pieces that do not need Electron.
export const KEYS = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34], Space: [32, ' '] };

export function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (/^(https?:\/\/)/i.test(s)) return new URL(s).href;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(s)) return new URL(`http://${s}`).href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[\w.-]+:\d+(\/|$)/.test(s)) throw new Error('Only http and https pages can be opened');
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(s)) return new URL(`https://${s}`).href;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

const S = (properties = {}, required = []) => ({ type: 'object', properties, required });
const tab = { tab: { type: 'string', description: 'Tab id; your current tab when left out' } };
export const BROWSER_TOOLS = [
  { name: 'browser_open', description: 'Open a URL in your browser tab and read the page. The user sees this browser.', inputSchema: S({ url: { type: 'string' }, new_tab: { type: 'boolean' }, ...tab }, ['url']) },
  { name: 'browser_read', description: 'Read the page: its text and its interactive elements, each with a ref for browser_click and browser_type.', inputSchema: S({ offset: { type: 'number', description: 'Start of the text to read' }, ...tab }) },
  { name: 'browser_find', description: 'Find text on the page: matching elements with refs and matching lines. Much cheaper than browser_read on a long page.', inputSchema: S({ text: { type: 'string' }, ...tab }, ['text']) },
  { name: 'browser_screenshot', description: 'See the page as an image. Costly: use browser_read or browser_find unless you need to see it.', inputSchema: S(tab) },
  { name: 'browser_click', description: 'Click an element by ref, by its visible text, or a point by x and y. Returns only what changed.', inputSchema: S({ ref: { type: 'string' }, text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, ...tab }) },
  { name: 'browser_type', description: 'Type into an element (by ref) or the focused one. Replaces the current value unless replace is false. Password, code and card fields are refused.', inputSchema: S({ text: { type: 'string' }, ref: { type: 'string' }, submit: { type: 'boolean' }, replace: { type: 'boolean' }, ...tab }, ['text']) },
  { name: 'browser_key', description: `Press one key: ${Object.keys(KEYS).join(', ')}.`, inputSchema: S({ key: { type: 'string' }, ...tab }, ['key']) },
  { name: 'browser_scroll', description: 'Scroll the page.', inputSchema: S({ direction: { type: 'string', enum: ['up', 'down'] }, ...tab }, ['direction']) },
  { name: 'browser_back', description: 'Go back.', inputSchema: S(tab) },
  { name: 'browser_console', description: 'Recent console messages of the page.', inputSchema: S(tab) },
  { name: 'browser_steps', description: 'Run several browser steps in one call, in order, stopping at the first error. Prefer this when you know the next steps. Each step is {"tool": "open"|"click"|"type"|"key"|"scroll"|"back"|"find"|"read", ...that tool\'s arguments}. Returns the last step\'s result.', inputSchema: S({ steps: { type: 'array', items: { type: 'object' } } }, ['steps']) },
  { name: 'browser_tabs', description: 'List open tabs and who opened them.', inputSchema: S() },
];
