// Isolated Electron UI check: npm exec electron test/sidebar-smoke.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copycli-sidebar-'));
app.setPath('userData', path.join(dir, 'profile'));
const source = path.resolve(__dirname, '../src');
const url = (f) => pathToFileURL(path.join(source, f)).href;
fs.writeFileSync(path.join(dir, 'preview.html'), `<!doctype html><html style="color-scheme:dark"><head><meta charset="utf-8"><link rel="stylesheet" href="${url('renderer/style.css')}"><link rel="stylesheet" href="${url('renderer/chat-sidebar.css')}"></head><body><aside id="side"><div class="drag"></div><div class="brand">CopyCLI</div><button id="new" class="wide">New chat</button><div class="sidebar-label">Conversations<span id="chat-count"></span></div><nav id="chats"></nav><button class="wide quiet">Settings</button></aside><main id="main"><header id="top">Conversation library</header><div class="empty"><h1>A place for every conversation.</h1><p>Search, pin, group and archive your chats.</p></div></main><script type="module">
import {createChatSidebar} from '${url('renderer/chat-sidebar.js')}';
import {applyChatUpdate} from '${url('shared/chats.js')}';
const h=(tag,props={},...kids)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(props)){if(v===null||v===undefined||v===false)continue;if(k.startsWith('on'))e[k]=v;else if(k==='class')e.className=v;else if(k in e&&k!=='list')e[k]=v;else e.setAttribute(k,v)}e.append(...kids.flat().filter(x=>x!==null&&x!==undefined&&x!==false));return e};
window.chats=[{id:'one',title:'Build the workspace',cwd:'/Users/demo/Desktop/CopyCLI',updated:4,messages:[]},{id:'two',title:'Computer vision · Lab 4',group:'University',cwd:'/Users/demo/Desktop/school/vision',updated:3,messages:[]},{id:'three',title:'Weekly planning',pinned:true,cwd:'/Users/demo/Desktop',updated:2,messages:[]},{id:'four',title:'An archived idea',archived:true,cwd:'/Users/demo/Desktop',updated:1,messages:[]}];
window.modalOpen=false;window.activeId='one';
window.sidebar=createChatSidebar({root:document.getElementById('chats'),h,nice:p=>p.replace('/Users/demo','~'),onOpen:id=>{window.activeId=id;window.sidebar.render(window.chats,id)},onUpdate:async(id,patch)=>{const c=window.chats.find(x=>x.id===id);applyChatUpdate(c,patch);window.sidebar.render(window.chats,window.activeId);return c},onDelete:async id=>{window.chats=window.chats.filter(c=>c.id!==id);return true},onModal:on=>{window.modalOpen=on}});
window.sidebar.render(window.chats,window.activeId);window.ready=true;
</script></body></html>`);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const ui = (js) => w.webContents.executeJavaScript(js);
  const errors = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  const until = async (f) => { const start = Date.now(); while (!(await f())) { if (Date.now() - start > 3000) throw Error('UI timeout'); await new Promise((r) => setTimeout(r, 20)); } };
  const more = (id) => ui(`document.querySelector('[data-chat-id="${id}"] .cb-more').click()`);
  const choose = (label) => ui(`[...document.querySelectorAll('.cb-menu-item')].find(e=>e.textContent===${JSON.stringify(label)}).click()`);
  const save = async (value) => { await ui(`document.querySelector('.cb-field').value=${JSON.stringify(value)};document.querySelector('.cb-dialog [type=submit]').click()`); await until(() => ui(`!document.querySelector('.cb-dialog')`)); };
  const filter = async (value) => ui(`document.querySelector('.cb-search').value=${JSON.stringify(value)};document.querySelector('.cb-search').dispatchEvent(new Event('input'))`);
  try {
    await w.loadFile(path.join(dir, 'preview.html')); await until(() => ui('window.ready===true'));
    assert.deepEqual(await ui(`[...document.querySelectorAll('[data-chat-id]')].map(e=>e.dataset.chatId)`), ['three', 'two', 'one']);
    await more('one'); await choose('Rename');
    assert.equal(await ui('window.modalOpen'), true);
    await save('CopyCLI redesign');
    assert.equal(await ui(`window.chats.find(c=>c.id==='one').title`), 'CopyCLI redesign');
    assert.equal(await ui('window.modalOpen'), false);
    await more('one'); await choose('Pin to top'); await until(() => ui(`window.chats.find(c=>c.id==='one').pinned===true`));
    assert.equal(await ui(`document.querySelector('[data-chat-id]').dataset.chatId`), 'one');
    await more('two'); await choose('Move to group…'); await save('Computer vision');
    assert.equal(await ui(`window.chats.find(c=>c.id==='two').group`), 'Computer vision');
    await more('one'); await choose('Archive chat'); await until(() => ui(`!document.querySelector('[data-chat-id="one"]')`));
    await ui(`document.querySelectorAll('.cb-filters button')[1].click()`);
    assert.equal(await ui(`!!document.querySelector('[data-chat-id="one"]')`), true);
    await more('one'); await choose('Restore chat'); await until(() => ui(`!document.querySelector('[data-chat-id="one"]')`));
    await ui(`document.querySelectorAll('.cb-filters button')[0].click()`);
    await filter('VISIO'); assert.equal(await ui(`document.querySelector('[data-chat-id]').dataset.chatId`), 'two');
    assert.equal(await ui(`document.activeElement===document.querySelector('.cb-search')`), false);
    await ui(`document.querySelector('.cb-search').focus()`); await filter('copycli');
    assert.equal(await ui(`document.activeElement===document.querySelector('.cb-search')`), true);
    await filter('');
    await more('one'); await ui(`document.querySelector('.cb-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    assert.equal(await ui(`document.activeElement===document.querySelector('[data-chat-id="one"] .cb-more')`), true);
    await more('one'); await choose('Rename');
    await ui(`document.querySelector('.cb-field').value='   ';document.querySelector('.cb-dialog [type=submit]').click()`);
    await until(() => ui(`!document.querySelector('.cb-dialog-error').hidden`));
    assert.equal(await ui(`window.chats.find(c=>c.id==='one').title`), 'CopyCLI redesign');
    await ui(`document.querySelector('.cb-dialog .quiet').click()`); await until(() => ui(`!document.querySelector('.cb-dialog')`));
    // Archiving a running chat asks first; Cancel keeps it visible and running.
    await ui(`window.chats.find(c=>c.id==='one').running=true;window.sidebar.render(window.chats,window.activeId)`);
    await more('one'); await choose('Archive chat');
    assert.match(await ui(`document.querySelector('.cb-dialog').innerText`), /still working/);
    await ui(`document.querySelector('.cb-dialog .quiet').click()`); await until(() => ui(`!document.querySelector('.cb-dialog')`));
    assert.equal(await ui(`!!document.querySelector('[data-chat-id="one"]')`), true);
    assert.equal(await ui(`document.getElementById('chats').scrollWidth>document.getElementById('chats').clientWidth`), false);
    if (process.env.COPYCLI_SHOTS) {
      fs.mkdirSync(process.env.COPYCLI_SHOTS, { recursive: true });
      await new Promise((r) => setTimeout(r, 180));
      fs.writeFileSync(path.join(process.env.COPYCLI_SHOTS, 'chat-sidebar.png'), (await w.webContents.capturePage()).toPNG());
      await more('one'); await choose('Rename');
      await until(() => ui(`document.querySelector('.cb-dialog')?.open===true`));
      await new Promise((r) => setTimeout(r, 180));
      fs.writeFileSync(path.join(process.env.COPYCLI_SHOTS, 'rename-chat.png'), (await w.webContents.capturePage()).toPNG());
    }
    assert.deepEqual(errors.filter((x) => !/Electron Security/.test(x)), []);
    console.log('SIDEBAR SMOKE OK'); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
}).catch((e) => { console.error(e); app.exit(1); });
