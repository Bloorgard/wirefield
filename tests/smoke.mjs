#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

function resolveChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const found = CHROME_CANDIDATES.find(path => existsSync(path));
  if (found) return found;
  throw new Error('Chromium не найден. Укажите путь: CHROME_BIN=/path/to/chrome npm run test:smoke');
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE_URL = process.env.WIRES_URL || 'http://127.0.0.1:8765/index.html';
const CHROME = resolveChrome();
const DEBUG_PORT = Number(process.env.CDP_PORT || 9222);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for browser');
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'wires-smoke-'));
  let server;
  let chrome;
  if (!process.env.WIRES_URL) {
    server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore']});
    await waitFor(async () => {
      const response = await fetch(PAGE_URL);
      return response.ok;
    });
  }
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank'
  ], {stdio: ['ignore', 'ignore', 'ignore']});
  let socket;
  let nextId = 1;
  const pending = new Map();
  const results = [];
  const pass = (name, detail = '') => { results.push({name, detail}); console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`); };
  const fail = (name, error) => { results.push({name, error: String(error)}); console.error(`FAIL ${name}: ${error}`); };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      return response.ok;
    });
    const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = pages.find(item => item.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('Chrome page target not found');

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once: true});
      socket.addEventListener('error', reject, {once: true});
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const {resolve, reject} = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });

    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
    });
    const evaluate = async expression => {
      const result = await cdp('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
      return result.result?.value;
    };
    const navigate = async () => {
      await cdp('Page.enable');
      await cdp('Runtime.enable');
      await cdp('Page.navigate', {url: PAGE_URL});
      await sleep(350);
      await waitFor(async () => (await evaluate('document.readyState')) === 'complete');
    };
    const TEST_FIXTURE = {version:1,cell:44,background:'#f200e9',pointsMatchBackground:false,gridVisible:true,wires:[{id:'0001',x:7,y:2,length:10,color:'#102cff'},{id:'0002',x:12,y:4,length:9,color:'#102cff'},{id:'0003',x:16,y:1,length:11,color:'#102cff'}]};
    const reset = async (defaultSketch=false) => {
      const storage=defaultSketch?'localStorage.clear();':`localStorage.clear();localStorage.setItem('wires-v2',${JSON.stringify(JSON.stringify(TEST_FIXTURE))});`;
      await evaluate(`${storage}location.reload();`);
      await sleep(350);
      await waitFor(async () => (await evaluate('document.readyState')) === 'complete');
    };
    const setViewport = async (width, height, mobile) => {
      await cdp('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile});
    };
    const state = () => evaluate("JSON.parse(localStorage.getItem('wires-v2'))");

    await setViewport(1280, 800, false);
    await navigate();
    await reset(true);
    try {
      const result = await evaluate(`(()=>{const stored=JSON.parse(localStorage.getItem('wires-v2')),byId=Object.fromEntries(stored.wires.map(w=>[w.id,w]));return {groups:document.querySelectorAll('.wire-group').length,rendered:[...document.querySelectorAll('.wire-body')].every(e=>Boolean(e.getAttribute('d'))),ids:[...document.querySelectorAll('.wire-group')].map(e=>e.dataset.id),wireLabel:document.querySelector('#wireCountLabel')?.textContent,layersLabel:document.querySelector('#layersToggle')?.textContent,canvas:getComputedStyle(document.querySelector('.canvas')).backgroundColor,state:{background:stored.background,pointMode:stored.pointMode,gridVisible:stored.gridVisible,count:stored.wires.length},pins:['0126','0127','0128'].map(id=>byId[id]),uniqueStarts:new Set(stored.wires.map(w=>w.x+','+w.y)).size,collisionButton:Boolean(document.querySelector('#collisionToggle')),collisionOff:document.querySelector('#collisionToggle')?.getAttribute('aria-pressed')==='false'}})()`);
      assert(result.groups === 48, `expected 48 groups, got ${result.groups}`);
      assert(result.rendered, 'one or more SVG paths has no d attribute');
      assert(result.ids[0] === '0002' && result.ids.at(-1) === '0128' && result.uniqueStarts === 48, `unexpected default IDs or pin layout: ${result.ids.join(',')}`);
      assert(result.canvas === 'rgb(16, 44, 255)' && result.state.background === '#102cff' && result.state.pointMode === 'white' && result.state.gridVisible, `unexpected default theme: ${JSON.stringify(result.state)}`);
      assert(JSON.stringify(result.pins) === JSON.stringify([{id:'0126',x:22,y:17,length:13,color:'#f8f5ed',endX:29,endY:9},{id:'0127',x:30,y:12,length:7.5,color:'#f8f5ed',endX:33,endY:18},{id:'0128',x:27,y:16,length:6.5,color:'#f8f5ed',endX:32,endY:13}]), `unexpected white pinned wires: ${JSON.stringify(result.pins)}`);
      assert(result.collisionButton && result.collisionOff, 'collision mode is not off by default');
      pass('fresh render', '48-wire blue default sketch with SVG geometry');
    } catch (error) { fail('fresh render', error); }

    await reset();
    try {
      const accessibility = await evaluate(`(()=>{const toast=document.querySelector('#toast'),dialog=document.querySelector('#codeDialog'),start=document.querySelector('.wire-group[data-id="0001"] .wire-start-hit'),before=JSON.parse(localStorage.getItem('wires-v2')).wires.find(w=>w.id==='0001').x;start.focus();start.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true}));const after=JSON.parse(localStorage.getItem('wires-v2')).wires.find(w=>w.id==='0001').x;return {toast:[toast.getAttribute('role'),toast.getAttribute('aria-live'),toast.getAttribute('aria-atomic')],dialog:[dialog.getAttribute('aria-labelledby'),dialog.getAttribute('aria-describedby'),document.querySelector('#codeArea').getAttribute('aria-label')],groups:[document.querySelector('.tool-controls').getAttribute('role'),document.querySelector('.view-controls').getAttribute('role'),document.querySelector('#canvas').getAttribute('role')],zoom:[document.querySelector('#zoomOut').getAttribute('aria-label'),document.querySelector('#zoomIn').getAttribute('aria-label')],swatches:[...document.querySelectorAll('.item.primary .layer-swatches .swatch')].map(button=>button.getAttribute('aria-label')),start:[start.getAttribute('role'),start.getAttribute('tabindex'),start.getAttribute('aria-label'),start.getAttribute('aria-keyshortcuts')],before,after}})()`);
      assert(JSON.stringify(accessibility.toast) === JSON.stringify(['status','polite','true']), `toast live region mismatch: ${JSON.stringify(accessibility.toast)}`);
      assert(accessibility.dialog[0] === 'codeDialogTitle' && accessibility.dialog[1] === 'codeDialogHelp' && accessibility.dialog[2]?.includes('.wires'), `dialog labels missing: ${JSON.stringify(accessibility.dialog)}`);
      assert(JSON.stringify(accessibility.groups) === JSON.stringify(['group','group','region']) && JSON.stringify(accessibility.zoom) === JSON.stringify(['Отдалить','Приблизить']), `control semantics missing: ${JSON.stringify(accessibility)}`);
      assert(accessibility.swatches.length === 6 && accessibility.swatches.every(label=>label?.startsWith('Цвет жгута #')), `layer swatches lack names: ${JSON.stringify(accessibility.swatches)}`);
      assert(accessibility.start[0] === 'button' && accessibility.start[1] === '0' && accessibility.start[2] === 'Начальная точка жгута 0001' && accessibility.start[3]?.includes('ArrowRight'), `point handle semantics missing: ${JSON.stringify(accessibility.start)}`);
      assert(accessibility.after === accessibility.before + 1, `keyboard point nudge failed: ${accessibility.before} -> ${accessibility.after}`);
      pass('accessible controls and point keyboard', 'live status, named dialog, labeled swatches, and ArrowRight point nudge');
    } catch (error) { fail('accessible controls and point keyboard', error); }

    await reset();
    try {
      const before = await state();
      await evaluate("document.querySelector('.item[data-id=\"0001\"] .item-main').click(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true}));");
      const moved = await state();
      assert(moved.wires.find(w => w.id === '0001').x === 8, 'ArrowRight did not move 0001');
      await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true}))");
      const undone = await state();
      assert(JSON.stringify(undone) === JSON.stringify(before), 'undo did not restore state');
      pass('keyboard move and undo');
    } catch (error) { fail('keyboard move and undo', error); }

    try {
      await evaluate("document.querySelector('#addBtn').click()");
      assert((await state()).wires.length === 4, 'add did not create a fourth wire');
      await evaluate("document.querySelector('.item.primary .layer-tools .trash').click()");
      assert((await state()).wires.length === 3, 'delete did not restore three wires');
      pass('add and delete');
    } catch (error) { fail('add and delete', error); }

    try {
      const limitFixture = {version:1,cell:44,background:'#f200e9',pointMode:'white',gridVisible:true,wires:Array.from({length:999},(_,i)=>({id:String(i+1).padStart(4,'0'),x:i,y:0,length:0,color:'#102cff'}))};
      await evaluate(`localStorage.clear();localStorage.setItem('wires-v2',${JSON.stringify(JSON.stringify(limitFixture))});location.reload()`);
      await sleep(1200);
      await waitFor(async () => (await evaluate("document.querySelectorAll('.wire-group').length")) === 999, 10000);
      const capacity = await evaluate(`(()=>{const count=()=>JSON.parse(localStorage.getItem('wires-v2')).wires.length,limitToast=()=>document.querySelector('#toast').textContent.includes('Лимит: 1000');document.querySelector('#addBtn').click();const afterBoundary=count();document.querySelector('#addBtn').click();const addBlocked={count:count(),toast:limitToast()};document.querySelector('.item.primary .copy').click();const duplicateBlocked={count:count(),toast:limitToast()};document.querySelector('#brushTool').click();const scene=document.querySelector('#scene'),r=scene.getBoundingClientRect(),x=r.left+44,y=r.top+176;scene.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:901,pointerType:'mouse',button:0,buttons:1,clientX:x,clientY:y}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:901,pointerType:'mouse',button:0,buttons:0,clientX:x,clientY:y}));const brushBlocked={count:count(),toast:limitToast()};document.querySelector('#selectTool').click();const body=document.querySelector('.wire-group[data-id="1000"] .wire-body');body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:902,pointerType:'mouse',button:0,buttons:1,altKey:true,clientX:x,clientY:y}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:902,pointerType:'mouse',button:0,buttons:0,altKey:true,clientX:x,clientY:y}));const altBlocked={count:count(),toast:limitToast()};return {afterBoundary,addBlocked,duplicateBlocked,brushBlocked,altBlocked}})()`);
      assert(capacity.afterBoundary === 1000, `999 boundary created ${capacity.afterBoundary} wires`);
      assert(['addBlocked','duplicateBlocked','brushBlocked','altBlocked'].every(key=>capacity[key].count===1000&&capacity[key].toast), `capacity path escaped: ${JSON.stringify(capacity)}`);
      pass('wire capacity boundary', 'Add reaches 1000; Add, Duplicate, Brush, and Alt-copy stop at the limit');
      await reset();
    } catch (error) { fail('wire capacity boundary', error); }

    try {
      await reset();
      const formatResult = await evaluate(`(()=>{
        const original=localStorage.getItem('wires-v2');
        document.querySelector('#codeBtn').click();
        const code=document.querySelector('#codeArea').value;
        document.querySelector('#applyBtn').click();
        const roundtrip=localStorage.getItem('wires-v2')===original;
        document.querySelector('#codeBtn').click();
        document.querySelector('#codeArea').value=code.replace(/color #[0-9a-f]{6}/i,'color #102cff EXTRA');
        document.querySelector('#applyBtn').click();
        const rejected=document.querySelector('#codeDialog').open && document.querySelector('#toast').textContent.includes('формат wire');
        document.querySelector('#codeDialog').close();
        return {roundtrip,rejected};
      })()`);
      assert(formatResult.roundtrip, 'valid .wires round-trip changed state');
      assert(formatResult.rejected, 'extra wire token was accepted');
      pass('.wires round-trip and strict rejection');
    } catch (error) { fail('.wires round-trip and strict rejection', error); }

    try {
      await reset();
      await evaluate(`(()=>{localStorage.setItem('wires-v2',JSON.stringify({version:1,cell:44,background:'#f200e9',pointsMatchBackground:false,gridVisible:true,wires:[{id:'0001',x:-4,y:2,length:10,color:'#102cff'},{id:'0002',x:12,y:4,length:9,color:'#102cff'},{id:'0003',x:16,y:1,length:11,color:'#102cff'}]}));location.reload()})()`);
      await sleep(2200);
      const repaired = await evaluate(`({x:JSON.parse(localStorage.getItem('wires-v2')).wires.find(w=>w.id==='0001').x,toast:document.querySelector('#toast').textContent})`);
      assert(repaired.x === 0, `repaired x is ${repaired.x}, expected 0`);
      assert(repaired.toast.includes('Данные были исправлены'), `missing repair notice: ${repaired.toast}`);
      pass('repaired localStorage notice');
    } catch (error) { fail('repaired localStorage notice', error); }

    try {
      await reset();
      const storageFailure = await evaluate(`(()=>{const descriptor=Object.getOwnPropertyDescriptor(Storage.prototype,'setItem');Object.defineProperty(Storage.prototype,'setItem',{...descriptor,value(){throw new DOMException('Quota exceeded','QuotaExceededError')}});try{document.querySelector('#addBtn').click();const groups=document.querySelectorAll('.wire-group').length,stored=JSON.parse(localStorage.getItem('wires-v2')).wires.length,toast=document.querySelector('#toast').textContent;document.querySelector('#codeBtn').click();const exported=(document.querySelector('#codeArea').value.match(/^wire /gm)||[]).length;document.querySelector('#codeDialog').close();return {groups,stored,toast,exported}}finally{Object.defineProperty(Storage.prototype,'setItem',descriptor)}})()`);
      assert(storageFailure.groups === 4 && storageFailure.stored === 3 && storageFailure.exported === 4, `storage failure lost the in-memory recovery copy: ${JSON.stringify(storageFailure)}`);
      assert(storageFailure.toast.includes('Автосохранение недоступно') && storageFailure.toast.includes('.wires'), `storage failure feedback missing: ${storageFailure.toast}`);
      pass('storage failure recovery', 'Quota error keeps the tab usable and exposes a four-wire .wires recovery copy');
    } catch (error) { fail('storage failure recovery', error); }

    try {
      await reset();
      const clipboard = await evaluate(`(async()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.querySelector('#codeBtn').click();document.querySelector('#copyBtn').click();await new Promise(resolve=>setTimeout(resolve,100));return document.querySelector('#toast').textContent})()`);
      assert(clipboard === 'Код скопирован' || clipboard === 'Не удалось скопировать код', `unexpected clipboard feedback: ${clipboard}`);
      pass('clipboard fallback feedback', clipboard);
    } catch (error) { fail('clipboard fallback feedback', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      const collapsed = await evaluate(`(()=>{const side=document.querySelector('.side'),button=document.querySelector('#layersToggle'),list=document.querySelector('#list'),quick=document.querySelector('#compactLayerControls'),legacy=document.querySelector('#inspector');return {height:parseFloat(getComputedStyle(side).height),button:getComputedStyle(button).display,list:getComputedStyle(list).display,quick:Boolean(quick),legacy:Boolean(legacy),toolDirection:getComputedStyle(document.querySelector('.tool-controls')).flexDirection,actionDirection:getComputedStyle(document.querySelector('.top-actions')).flexDirection}})()`);
      assert(collapsed.height >= 145 && collapsed.height <= 170, `collapsed panel is ${collapsed.height}px`);
      assert(collapsed.button !== 'none', 'mobile layers button is hidden');
      assert(collapsed.list === 'none', 'mobile layer list is open by default');
      assert(!collapsed.quick && !collapsed.legacy, 'legacy selected-wire block is still present');
      assert(collapsed.toolDirection === 'column' && collapsed.actionDirection === 'column', 'mobile top menus are not stacked');
      const expanded = await evaluate(`(()=>{const b=document.querySelector('#layersToggle');b.click();const list=document.querySelector('#list'),side=document.querySelector('.side'),sr=side.getBoundingClientRect(),lr=list.getBoundingClientRect();return {open:side.classList.contains('layers-open'),list:getComputedStyle(list).display,fullWidth:lr.width>sr.width-30}})()`);
      assert(expanded.open && expanded.list === 'block' && expanded.fullWidth, 'mobile layer panel did not open full width');
      await evaluate("document.querySelector('#layersToggle').click()");
      pass('mobile layers panel', `${collapsed.height}px collapsed, toggle opens list`);
    } catch (error) { fail('mobile layers panel', error); }

    try {
      await reset();
      const bodyDrag = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),body=document.querySelector('.wire-group[data-id="0001"] .wire-body'),r=scene.getBoundingClientRect(),sx=r.left+330,sy=r.top+300;body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:99,pointerType:'touch',button:0,buttons:1,clientX:sx,clientY:sy}));scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:99,pointerType:'touch',button:0,buttons:1,clientX:sx+132,clientY:sy+44}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:99,pointerType:'touch',button:0,buttons:0,clientX:sx+132,clientY:sy+44}));await new Promise(resolve=>setTimeout(resolve,60));return JSON.parse(localStorage.getItem('wires-v2')).wires.find(w=>w.id==='0001').x})()`);
      assert(bodyDrag === 7, `body drag changed x to ${bodyDrag}`);
      pass('body drag disabled');
    } catch (error) { fail('body drag disabled', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      const touchDrag = await evaluate(`(async()=>{
        const scene=document.querySelector('#scene'),dot=document.querySelector('.wire-group[data-id="0001"] .wire-dot'),r=scene.getBoundingClientRect(),sx=r.left+330,sy=r.top+110,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),read=()=>document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d');
        dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:100,pointerType:'touch',button:0,buttons:1,clientX:sx,clientY:sy}));dot.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:100,pointerType:'touch',button:0,buttons:0,clientX:sx,clientY:sy}));dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:101,pointerType:'touch',button:0,buttons:1,clientX:sx,clientY:sy}));
        scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:101,pointerType:'touch',button:0,buttons:1,clientX:sx+132,clientY:sy+44}));
        await wait(120);
        scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:101,pointerType:'touch',button:0,buttons:0,clientX:sx+132,clientY:sy+44}));
        const samples=[];for(let i=0;i<8;i++){await wait(100);samples.push(read())}
        return {unique:new Set(samples).size,moved:JSON.parse(localStorage.getItem('wires-v2')).wires.find(w=>w.id==='0001').x===10};
      })()`);
      assert(touchDrag.moved, 'touch drag did not commit x=10');
      assert(touchDrag.unique >= 3, `touch release produced only ${touchDrag.unique} unique geometries`);
      pass('mobile touch drag', `${touchDrag.unique} geometries after touch release`);
    } catch (error) { fail('mobile touch drag', error); }

    try {
      await reset();
      const before = JSON.stringify(await state());
      const cancelled = await evaluate(`(async()=>{
        const scene=document.querySelector('#scene'),dot=document.querySelector('.wire-group[data-id="0001"] .wire-dot'),r=scene.getBoundingClientRect(),sx=r.left+330,sy=r.top+110;
        dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:103,pointerType:'touch',button:0,buttons:1,clientX:sx,clientY:sy}));dot.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:103,pointerType:'touch',button:0,buttons:0,clientX:sx,clientY:sy}));dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:102,pointerType:'touch',button:0,buttons:1,clientX:sx,clientY:sy}));
        scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:102,pointerType:'touch',button:0,buttons:1,clientX:sx+132,clientY:sy+44}));
        scene.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:102,pointerType:'touch',button:0,buttons:0,clientX:sx+132,clientY:sy+44}));
        await new Promise(resolve=>setTimeout(resolve,100));
        return JSON.stringify(JSON.parse(localStorage.getItem('wires-v2')));
      })()`);
      assert(cancelled === before, 'pointercancel changed persisted state');
      pass('mobile pointercancel rollback');
    } catch (error) { fail('mobile pointercancel rollback', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      await evaluate(`localStorage.setItem('wires-v2',JSON.stringify({version:1,cell:44,background:'#f200e9',pointsMatchBackground:false,gridVisible:true,wires:[{id:'0001',x:7,y:2,length:8,color:'#102cff'},{id:'0002',x:12,y:4,length:8,endX:15,endY:4,color:'#102cff'},{id:'0003',x:18,y:1,length:7,color:'#102cff'}]}));localStorage.setItem('wires-view-v1',JSON.stringify({x:0,y:0,zoom:1}));location.reload()`);
      await sleep(450);
      const mixedPointDrag = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),start=document.querySelector('.wire-group[data-id="0001"] .wire-dot'),tail=document.querySelector('.wire-group[data-id="0002"] .wire-tail-hit'),r=scene.getBoundingClientRect(),sx=r.left+330,sy=r.top+110,tx=r.left+682,ty=r.top+198,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));start.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:201,pointerType:'mouse',button:0,buttons:1,clientX:sx,clientY:sy}));start.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:201,pointerType:'mouse',button:0,buttons:0,clientX:sx,clientY:sy}));tail.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:202,pointerType:'mouse',button:0,buttons:1,ctrlKey:true,clientX:tx,clientY:ty}));tail.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:202,pointerType:'mouse',button:0,buttons:0,ctrlKey:true,clientX:tx,clientY:ty}));const selected={start:document.querySelector('.wire-group[data-id="0001"] .wire-dot').classList.contains('point-selected'),tail:document.querySelector('.wire-group[data-id="0002"] .wire-tail-dot').classList.contains('point-selected')};tail.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:203,pointerType:'mouse',button:0,buttons:1,clientX:tx,clientY:ty}));scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:203,pointerType:'mouse',button:0,buttons:1,clientX:tx+44,clientY:ty+44}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:203,pointerType:'mouse',button:0,buttons:0,clientX:tx+44,clientY:ty+44}));await wait(120);const wires=JSON.parse(localStorage.getItem('wires-v2')).wires;const a=wires.find(w=>w.id==='0001'),b=wires.find(w=>w.id==='0002');return {selected,moved:a.x===8&&a.y===3&&b.endX===16&&b.endY===5,wires:[a.x,a.y,b.endX,b.endY]}})()`);
      assert(mixedPointDrag.selected.start && mixedPointDrag.selected.tail, 'mixed start and tail selection did not persist');
      assert(mixedPointDrag.moved, `mixed point drag moved to ${mixedPointDrag.wires.join(',')}`);
      pass('mixed point selection and drag', 'start and tail moved together');
    } catch (error) { fail('mixed point selection and drag', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const commandPoints = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),hitA=document.querySelector('.wire-group[data-id="0001"] .wire-hit'),hitB=document.querySelector('.wire-group[data-id="0003"] .wire-hit'),r=scene.getBoundingClientRect(),ax=r.left+330,ay=r.top+110,bx=r.left+726,by=r.top+66;hitA.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:230,pointerType:'mouse',button:0,buttons:1,metaKey:true,clientX:ax,clientY:ay}));hitB.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:231,pointerType:'mouse',button:0,buttons:1,metaKey:true,clientX:bx,clientY:by}));const selected={a:document.querySelector('.wire-group[data-id="0001"] .wire-dot').classList.contains('point-selected'),b:document.querySelector('.wire-group[data-id="0003"] .wire-dot').classList.contains('point-selected')};const dot= document.querySelector('.wire-group[data-id="0003"] .wire-dot');dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:232,pointerType:'mouse',button:0,buttons:1,metaKey:true,clientX:bx,clientY:by}));scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:232,pointerType:'mouse',button:0,buttons:1,clientX:bx+44,clientY:by}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:232,pointerType:'mouse',button:0,buttons:0,clientX:bx+44,clientY:by}));await new Promise(resolve=>setTimeout(resolve,100));const wires=JSON.parse(localStorage.getItem('wires-v2')).wires;return {selected,moved:wires.find(w=>w.id==='0001').x===8&&wires.find(w=>w.id==='0003').x===17}})()`);
      assert(commandPoints.selected.a && commandPoints.selected.b, 'Command click did not add both point selections');
      assert(commandPoints.moved, 'Command-selected points did not move together');
      pass('Command point selection', 'Mac modifier selects and drags multiple points');
    } catch (error) { fail('Command point selection', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const boxedPoints = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),dots=['0001','0003'].map(id=>document.querySelector('.wire-group[data-id="'+id+'"] .wire-dot')),rects=dots.map(dot=>dot.getBoundingClientRect()),left=Math.min(...rects.map(r=>r.left))-8,right=Math.max(...rects.map(r=>r.right))+8,top=Math.min(...rects.map(r=>r.top))-8,bottom=Math.max(...rects.map(r=>r.bottom))+8,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));scene.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:233,pointerType:'mouse',button:0,buttons:1,metaKey:true,clientX:left,clientY:top}));scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:233,pointerType:'mouse',button:0,buttons:1,metaKey:true,clientX:right,clientY:bottom}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:233,pointerType:'mouse',button:0,buttons:0,metaKey:true,clientX:right,clientY:bottom}));const selected=dots.map(dot=>dot.classList.contains('point-selected'));const r=rects[1],dot=dots[1],x=r.left+r.width/2,y=r.top+r.height/2;dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:234,pointerType:'mouse',button:0,buttons:1,clientX:x,clientY:y}));scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:234,pointerType:'mouse',button:0,buttons:1,clientX:x+44,clientY:y}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:234,pointerType:'mouse',button:0,buttons:0,clientX:x+44,clientY:y}));await wait(100);const wires=JSON.parse(localStorage.getItem('wires-v2')).wires;return {selected,moved:wires.find(w=>w.id==='0001').x===8&&wires.find(w=>w.id==='0003').x===17}})()`);
      assert(boxedPoints.selected.every(Boolean), `selection box state ${JSON.stringify(boxedPoints)}`);
      assert(boxedPoints.moved, 'selection-box point group did not move together');
      pass('selection-box point group drag', 'Cmd box selected start points and moved them together');
    } catch (error) { fail('selection-box point group drag', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const groupedLayers = await evaluate(`(()=>{const select=(id,shift=false)=>document.querySelector('.item[data-id="'+id+'"] .item-main').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:shift}));select('0001');select('0002',true);window.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,code:'BracketRight',key:']',ctrlKey:true}));const state=JSON.parse(localStorage.getItem('wires-v2'));return {selected:[...document.querySelectorAll('.item.active')].map(row=>row.dataset.id),order:state.wires.map(w=>w.id)}})()`);
      assert(groupedLayers.selected.length === 2, `expected 2 selected layers, got ${groupedLayers.selected.length}`);
      assert(groupedLayers.order.join(',') === '0003,0001,0002', `selected layers reordered as ${groupedLayers.order.join(',')}`);
      pass('group layer reorder', 'selected layers moved together and kept order');
    } catch (error) { fail('group layer reorder', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      await evaluate(`localStorage.setItem('wires-v2',JSON.stringify({version:1,cell:44,background:'#f200e9',pointsMatchBackground:false,gridVisible:true,wires:[{id:'0001',x:12,y:4,length:8,color:'#102cff'},{id:'0002',x:3,y:1,length:8,color:'#102cff'},{id:'0003',x:7,y:1,length:8,color:'#102cff'}]}));location.reload()`);
      await sleep(450);
      const sortedLayers = await evaluate(`(()=>{const button=document.querySelector('#sortLayers');button.click();const first=JSON.parse(localStorage.getItem('wires-v2')).wires.map(w=>w.id);const firstTitle=button.title;button.click();const second=JSON.parse(localStorage.getItem('wires-v2')).wires.map(w=>w.id);return {first,second,firstTitle}})()`);
      assert(sortedLayers.first.join(',') === '0002,0003,0001', `top-down order is ${sortedLayers.first.join(',')}`);
      assert(sortedLayers.second.join(',') === '0001,0003,0002', `bottom-up order is ${sortedLayers.second.join(',')}`);
      assert(sortedLayers.firstTitle.includes('снизу вверх'), `next sort direction title is ${sortedLayers.firstTitle}`);
      pass('coordinate layer sorting', 'top-down and bottom-up orders follow x/y');
    } catch (error) { fail('coordinate layer sorting', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const altCopy = await evaluate(`(async()=>{const select=(id,shift=false)=>document.querySelector('.item[data-id="'+id+'"] .item-main').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:shift}));select('0001');select('0002',true);const scene=document.querySelector('#scene'),hit=document.querySelector('.wire-group[data-id="0001"] .wire-hit'),r=scene.getBoundingClientRect(),sx=r.left+330,sy=r.top+240;hit.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:240,pointerType:'mouse',button:0,buttons:1,altKey:true,clientX:sx,clientY:sy}));scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:240,pointerType:'mouse',button:0,buttons:1,altKey:true,clientX:sx+88,clientY:sy+44}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:240,pointerType:'mouse',button:0,buttons:0,altKey:true,clientX:sx+88,clientY:sy+44}));await new Promise(resolve=>setTimeout(resolve,120));const wires=JSON.parse(localStorage.getItem('wires-v2')).wires,copies=wires.filter(w=>w.id==='0004'||w.id==='0005');return {count:wires.length,selected:[...document.querySelectorAll('.item.active')].map(row=>row.dataset.id),copies:copies.map(w=>[w.x,w.y])}})()`);
      assert(altCopy.count === 5, `Alt drag created ${altCopy.count-3} copies`);
      assert(altCopy.copies.length === 2 && altCopy.copies.every(([x,y])=>x>=9&&y>=3), `Alt copies did not move: ${JSON.stringify(altCopy.copies)}`);
      pass('Alt copy drag', 'selected objects copied and moved together');
    } catch (error) { fail('Alt copy drag', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const nativeZoom = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),r=scene.getBoundingClientRect(),before=Number(document.querySelector('#zoom').value);scene.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-120,clientX:r.width/2,clientY:r.height/2}));await new Promise(resolve=>setTimeout(resolve,40));return {before,after:Number(document.querySelector('#zoom').value),min:document.querySelector('#zoom').min,fileMenu:Boolean(document.querySelector('.file-menu')),legacyActions:document.querySelectorAll('.top-actions > button:not(#gravityToggle):not(#collisionToggle)').length,gravityButton:Boolean(document.querySelector('#gravityToggle')),layerIcons:document.querySelectorAll('.item.primary .layer-tools .icon').length,lengthIcons:document.querySelectorAll('.item.primary .length-control .icon').length}})()`);
      assert(nativeZoom.after > nativeZoom.before, 'Ctrl+wheel did not zoom in');
      assert(nativeZoom.min === '20', `zoom minimum is ${nativeZoom.min}`);
      assert(nativeZoom.fileMenu && nativeZoom.legacyActions === 0, 'file actions were not merged into one menu');
      assert(nativeZoom.gravityButton, 'gravity toggle is missing');
      assert(nativeZoom.layerIcons === 6, `expected 6 layer icons, got ${nativeZoom.layerIcons}`);
      assert(nativeZoom.lengthIcons === 3, `expected 3 length icons, got ${nativeZoom.lengthIcons}`);
      pass('native zoom and integrated icons', `${nativeZoom.after}% zoom, min ${nativeZoom.min}%`);
    } catch (error) { fail('native zoom and integrated icons', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const toolbar = await evaluate(`(()=>{const ids=['addTool','selectTool','brushTool','eraseTool'],before=document.querySelectorAll('.wire-group').length;document.querySelector('#addTool').click();return {icons:ids.map(id=>Boolean(document.querySelector('#'+id+' .icon'))),sizes:[...ids,'resetView'].map(id=>getComputedStyle(document.querySelector('#'+id+' .icon')).width),labels:ids.map(id=>document.querySelector('#'+id).getAttribute('aria-label')),centerIcon:Boolean(document.querySelector('#resetView .icon')),count:document.querySelectorAll('.wire-group').length,before}})()`);
      assert(toolbar.icons.every(Boolean) && toolbar.centerIcon, `toolbar SVGs missing: ${JSON.stringify(toolbar)}`);
      assert(toolbar.sizes.every(size=>size === '30px'), `toolbar icon sizes are ${toolbar.sizes.join(',')}`);
      assert(toolbar.labels.join(',') === 'Добавить жгут,Курсор,Карандаш,Ластик', `toolbar labels are ${toolbar.labels.join(',')}`);
      assert(toolbar.count === toolbar.before + 1, `top add changed wire count from ${toolbar.before} to ${toolbar.count}`);
      pass('icon toolbar and top add', 'archive SVGs rendered and top add created one wire');
    } catch (error) { fail('icon toolbar and top add', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const topMenu = await evaluate(`(()=>{const actions=['#gravityToggle','#collisionToggle','.file-menu summary'].map(selector=>{const style=getComputedStyle(document.querySelector(selector));return {fontSize:style.fontSize,letterSpacing:style.letterSpacing,textTransform:style.textTransform,paddingLeft:style.paddingLeft,paddingRight:style.paddingRight}}),swatches=[...document.querySelectorAll('.theme-swatch')],rects=swatches.map(button=>{const r=button.getBoundingClientRect();return {width:r.width,height:r.height,color:button.dataset.background,pressed:button.getAttribute('aria-pressed')}});swatches[1].click();const blue={stored:JSON.parse(localStorage.getItem('wires-v2')).background,pressed:swatches.map(button=>button.getAttribute('aria-pressed')),canvas:getComputedStyle(document.querySelector('#canvas')).backgroundColor};swatches[2].click();const white={stored:JSON.parse(localStorage.getItem('wires-v2')).background,pressed:swatches.map(button=>button.getAttribute('aria-pressed')),canvas:getComputedStyle(document.querySelector('#canvas')).backgroundColor};return {actions,rects,blue,white}})()`);
      assert(topMenu.actions.every(style=>style.fontSize === '12px' && style.letterSpacing === '0.96px' && style.textTransform === 'uppercase' && style.paddingLeft === '13px' && style.paddingRight === '13px'), `top action typography or padding diverged: ${JSON.stringify(topMenu.actions)}`);
      assert(topMenu.rects.length === 3 && topMenu.rects.every(swatch=>swatch.width === 36 && swatch.height === 36) && topMenu.rects.filter(swatch=>swatch.pressed === 'true').length === 1, `background swatches invalid: ${JSON.stringify(topMenu.rects)}`);
      assert(topMenu.blue.stored === '#102cff' && topMenu.blue.pressed.join(',') === 'false,true,false' && topMenu.blue.canvas === 'rgb(16, 44, 255)', `blue swatch did not apply: ${JSON.stringify(topMenu.blue)}`);
      assert(topMenu.white.stored === '#ffffff' && topMenu.white.pressed.join(',') === 'false,false,true' && topMenu.white.canvas === 'rgb(255, 255, 255)', `white swatch did not apply: ${JSON.stringify(topMenu.white)}`);
      pass('top menu swatches', 'three square background choices switch the persisted canvas color');
    } catch (error) { fail('top menu typography', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const pointModes = await evaluate(`(()=>{const buttons=[...document.querySelectorAll('.point-mode-button')],dot=document.querySelector('.wire-group[data-id="0001"] .wire-dot'),sample=()=>({mode:JSON.parse(localStorage.getItem('wires-v2')).pointMode,pressed:buttons.map(button=>button.getAttribute('aria-pressed')),fill:getComputedStyle(dot).fill}),rects=buttons.map(button=>{const r=button.getBoundingClientRect();return {width:r.width,height:r.height}});buttons[1].click();const wire=sample();buttons[0].click();const white=sample();document.querySelector('.theme-swatch[data-background="#ffffff"]').click();buttons[0].click();const whiteOnWhite=sample();document.querySelector('.theme-swatch[data-background="#f200e9"]').click();buttons[2].click();const background=sample();return {rects,wire,white,whiteOnWhite,background}})()`);
      assert(pointModes.rects.length === 3 && pointModes.rects.every(rect=>rect.width === 24 && rect.height === 36), `point mode button geometry invalid: ${JSON.stringify(pointModes.rects)}`);
      assert(pointModes.wire.mode === 'wire' && pointModes.wire.pressed.join(',') === 'false,true,false' && pointModes.wire.fill === 'rgb(16, 44, 255)', `wire point mode failed: ${JSON.stringify(pointModes.wire)}`);
      assert(pointModes.white.mode === 'white' && pointModes.white.pressed.join(',') === 'true,false,false' && pointModes.white.fill === 'rgb(248, 245, 237)', `white point mode failed: ${JSON.stringify(pointModes.white)}`);
      assert(pointModes.whiteOnWhite.mode === 'white' && pointModes.whiteOnWhite.pressed.join(',') === 'true,false,false' && pointModes.whiteOnWhite.fill === 'rgb(16, 44, 255)', `white-background contrast mode failed: ${JSON.stringify(pointModes.whiteOnWhite)}`);
      assert(pointModes.background.mode === 'background' && pointModes.background.pressed.join(',') === 'false,false,true' && pointModes.background.fill === 'rgb(242, 0, 233)', `background point mode failed: ${JSON.stringify(pointModes.background)}`);
      pass('point color modes', 'white, wire-color, and background-color point modes render and persist');
    } catch (error) { fail('point color modes', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const gridState = await evaluate(`(()=>{const button=document.querySelector('#gridToggle'),canvas=document.querySelector('.canvas'),sample=()=>({pressed:button.getAttribute('aria-pressed'),active:button.getAttribute('aria-pressed')==='true',hidden:canvas.classList.contains('grid-hidden'),label:button.getAttribute('aria-label'),color:getComputedStyle(button).color});const enabled=sample();button.click();const disabled=sample();return {enabled,disabled}})()`);
      assert(gridState.enabled.pressed === 'true' && gridState.enabled.active && !gridState.enabled.hidden && gridState.enabled.label === 'Спрятать сетку' && gridState.enabled.color === 'rgb(242, 0, 233)', `visible grid control state invalid: ${JSON.stringify(gridState.enabled)}`);
      assert(gridState.disabled.pressed === 'false' && !gridState.disabled.active && gridState.disabled.hidden && gridState.disabled.label === 'Показать сетку' && gridState.disabled.color === 'rgb(248, 245, 237)', `hidden grid control state invalid: ${JSON.stringify(gridState.disabled)}`);
      pass('grid button state', 'active styling and ARIA now track a visible grid');
    } catch (error) { fail('grid button state', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const lengthGeometry = await evaluate(`(()=>{const row=document.querySelector('.item.primary .length-control'),item=row.closest('.item'),input=row.querySelector('input'),buttons=[...row.querySelectorAll('button')].map(button=>button.getBoundingClientRect().width),range=input.getBoundingClientRect(),rows=[item.querySelector('.item-main'),row,item.querySelector('.layer-swatches'),item.querySelector('.layer-tools')].map(element=>element.getBoundingClientRect().height),divider=row.querySelector('.length-divider').getBoundingClientRect(),style=getComputedStyle(input);input.value=input.min;const min=input.value;input.value=input.max;const max=input.value;return {min,max,padding:[style.paddingLeft,style.paddingRight],backgroundSize:style.backgroundSize,backgroundRepeat:style.backgroundRepeat,divider:[style.borderRightWidth,getComputedStyle(row.querySelector('.length-up')).borderLeftWidth,divider.width,divider.height],buttons,rangeWidth:range.width,rows}})()`);
      assert(lengthGeometry.min === '0', `length slider min is ${lengthGeometry.min}`);
      assert(lengthGeometry.max === '48', `length slider max is ${lengthGeometry.max}`);
      assert(lengthGeometry.padding.join(',') === '0px,0px', `length slider padding is ${lengthGeometry.padding.join(',')}`);
      assert(lengthGeometry.backgroundSize.includes('18px') && lengthGeometry.backgroundRepeat === 'no-repeat', `length track geometry is ${lengthGeometry.backgroundSize} / ${lengthGeometry.backgroundRepeat}`);
      assert(lengthGeometry.divider[0] === '0px' && lengthGeometry.divider[1] === '0px' && Math.abs(lengthGeometry.divider[2]) < .01 && Math.abs(lengthGeometry.divider[3]) < .01, `border-free divider geometry is ${lengthGeometry.divider.join(',')}`);
      assert(lengthGeometry.buttons.every(width => Math.abs(width - lengthGeometry.buttons[0]) < .05), `length button widths differ: ${lengthGeometry.buttons.join(',')}`);
      assert(Math.abs(lengthGeometry.rangeWidth / lengthGeometry.buttons[0] - 3) < .01, `length slider ratio is ${lengthGeometry.rangeWidth / lengthGeometry.buttons[0]}`);
      assert(lengthGeometry.rows.every(height => Math.abs(height - 40) < .01), `compact row heights are ${lengthGeometry.rows.join(',')}`);
      const compactEdges = await evaluate(`(()=>{const item=document.querySelector('.item.primary');return [item.querySelector('.item-main'),item.querySelector('.length-control'),item.querySelector('.layer-swatches'),item.querySelector('.layer-tools')].map(element=>{const rect=element.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width}})})()`);
      assert(compactEdges.every(edge => Math.abs(edge.left - compactEdges[0].left) < .01 && Math.abs(edge.right - compactEdges[0].right) < .01), `compact row edges differ: ${JSON.stringify(compactEdges)}`);
      const compactColumns = await evaluate(`(()=>{const item=document.querySelector('.item.primary'),rects=selector=>[...item.querySelectorAll(selector)].map(element=>{const rect=element.getBoundingClientRect();return [rect.left,rect.right]}),row=item.querySelector('.length-control'),length=[...row.querySelectorAll('button,input')].map(element=>{const rect=element.getBoundingClientRect();return [rect.left,rect.right]});return {palette:rects('.layer-swatches .swatch'),actions:rects('.layer-tools .layer-btn'),length}})()`);
      assert(compactColumns.palette.length === 6 && compactColumns.actions.length === 6 && compactColumns.palette.every((edge,index) => edge.every((value,side) => Math.abs(value - compactColumns.actions[index][side]) < .01)), `palette/action dividers differ: ${JSON.stringify(compactColumns)}`);
      const [minButton,downButton,slider,upButton] = compactColumns.length;
      assert(compactColumns.length.length === 4 && minButton.every((value,side) => Math.abs(value - compactColumns.palette[0][side]) < .01) && downButton.every((value,side) => Math.abs(value - compactColumns.palette[1][side]) < .01) && Math.abs(slider[0] - compactColumns.palette[2][0]) < .01 && Math.abs(slider[1] - compactColumns.palette[4][1]) < .01 && upButton.every((value,side) => Math.abs(value - compactColumns.palette[5][side]) < .01), `length-row dividers differ: ${JSON.stringify(compactColumns)}`);
      pass('desktop length slider geometry', 'four 40px rows; every shared column edge aligns; 1/6 · 1/6 · 1/2 · 1/6 with a thumb-aligned track');
    } catch (error) { fail('desktop length slider geometry', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const cardContrast = await evaluate(`(()=>{const choose=color=>{const swatch=[...document.querySelectorAll('.item.primary .layer-swatches .swatch')].find(button=>button.title===color);swatch.click();const row=document.querySelector('.item.primary'),main=row.querySelector('.item-main'),icon=row.querySelector('.length-up .icon');return {background:getComputedStyle(row,'::before').backgroundColor,foreground:getComputedStyle(main).color,icon:getComputedStyle(icon).stroke}};return {black:choose('#0b1118'),pink:choose('#f200e9'),light:choose('#ffc642')}})()`);
      assert(cardContrast.black.background === 'rgb(11, 17, 24)', `black card background is ${cardContrast.black.background}`);
      assert(cardContrast.black.foreground === 'rgb(248, 245, 237)' && cardContrast.black.icon === 'rgb(248, 245, 237)', `black card foreground is ${JSON.stringify(cardContrast.black)}`);
      assert(cardContrast.pink.background === 'rgb(242, 0, 233)', `pink card background is ${cardContrast.pink.background}`);
      assert(cardContrast.pink.foreground === 'rgb(248, 245, 237)' && cardContrast.pink.icon === 'rgb(248, 245, 237)', `pink card foreground is ${JSON.stringify(cardContrast.pink)}`);
      assert(cardContrast.light.background === 'rgb(255, 198, 66)', `light card background is ${cardContrast.light.background}`);
      assert(cardContrast.light.foreground === 'rgb(11, 17, 24)' && cardContrast.light.icon === 'rgb(11, 17, 24)', `light card foreground is ${JSON.stringify(cardContrast.light)}`);
      pass('wire-color settings card contrast', 'black and pink wires use light text and SVG; light wire uses dark text and SVG');
    } catch (error) { fail('wire-color settings card contrast', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      const gravity = await evaluate(`(async()=>{if(!('DeviceMotionEvent' in window))window.DeviceMotionEvent=function(){};if(!('DeviceOrientationEvent' in window))window.DeviceOrientationEvent=function(){};const button=document.querySelector('#gravityToggle'),labelBefore=button.textContent.trim(),backgroundBefore=getComputedStyle(button).backgroundColor,before=document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d');button.click();await new Promise(resolve=>setTimeout(resolve,300));const labelOn=button.textContent.trim(),backgroundOn=getComputedStyle(button).backgroundColor,event=new Event('devicemotion');Object.defineProperty(event,'accelerationIncludingGravity',{value:{x:9.81,y:0,z:0}});window.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,180));const changed=before!==document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d');const onPressed=button.getAttribute('aria-pressed');button.click();await new Promise(resolve=>setTimeout(resolve,40));const offPressed=button.getAttribute('aria-pressed'),labelOff=button.textContent.trim();window.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,80));return {pressed:onPressed,changed,offPressed,labelBefore,labelOn,labelOff,backgroundBefore,backgroundOn}})()`);
      assert(gravity.pressed === 'true', 'gravity toggle did not activate');
      assert(gravity.changed, 'device motion did not wake wire physics');
      assert(gravity.offPressed === 'false', 'gravity toggle did not deactivate');
      assert(gravity.labelBefore === 'гравитация' && gravity.labelOn === 'гравитация' && gravity.labelOff === 'гравитация', `gravity label changed with state: ${JSON.stringify(gravity)}`);
      assert(gravity.backgroundBefore !== gravity.backgroundOn, `gravity active fill did not change: ${JSON.stringify(gravity)}`);
      pass('device gravity', 'motion sample changed the wire vector');
    } catch (error) { fail('device gravity', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      const doubleTap = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),r=scene.getBoundingClientRect(),v=JSON.parse(localStorage.getItem('wires-view-v1')),x=r.left+80,y=r.top+250,send=(type,id)=>scene.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:id,pointerType:'touch',button:0,buttons:type==='pointerdown'?1:0,clientX:x,clientY:y}));send('pointerdown',201);send('pointerup',201);await new Promise(resolve=>setTimeout(resolve,80));send('pointerdown',202);send('pointerup',202);await new Promise(resolve=>setTimeout(resolve,100));const next=JSON.parse(localStorage.getItem('wires-v2'));return {count:next.wires.length,selected:[...document.querySelectorAll('.item.primary')].map(e=>e.dataset.id),zoom:v.zoom}})()`);
      assert(doubleTap.count === 4, `double-tap created ${doubleTap.count - 3} objects`);
      assert(doubleTap.selected.length === 1, 'double-tap did not select the created object');
      pass('mobile double-tap creation', `created ${doubleTap.selected[0]}`);
    } catch (error) { fail('mobile double-tap creation', error); }

    try {
      await reset();
      const lengthResult = await evaluate(`(async()=>{document.querySelector('#layersToggle').click();const input=document.querySelector('.item.primary .length-control input'),before=document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d');input.value='12';input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:203,pointerType:'touch',clientX:120,clientY:700}));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,80));const after=document.querySelector('.item.primary .wire-body')?.getAttribute('d'),wire=JSON.parse(localStorage.getItem('wires-v2')).wires.find(w=>w.id==='0001');return {length:wire.length,pathChanged:before!==after,controls:document.querySelectorAll('.item.primary .length-control button').length}})()`);
      assert(lengthResult.length === 12, `mobile length is ${lengthResult.length}`);
      assert(lengthResult.pathChanged, 'length change did not update SVG geometry immediately');
      assert(lengthResult.controls === 3, `expected 3 length controls, got ${lengthResult.controls}`);
      pass('mobile length controls', 'length and geometry update without canvas shake');
    } catch (error) { fail('mobile length controls', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      const pinch = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),r=scene.getBoundingClientRect(),x=r.left+170,y=r.top+250;const down=(id,cx,cy)=>scene.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:id,pointerType:'touch',button:0,buttons:1,clientX:cx,clientY:cy})),move=(id,cx,cy)=>scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:id,pointerType:'touch',button:0,buttons:1,clientX:cx,clientY:cy})),up=id=>scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:id,pointerType:'touch',button:0,buttons:0,clientX:x,clientY:y}));down(204,x-30,y);down(205,x+30,y);move(205,x+60,y);await new Promise(resolve=>setTimeout(resolve,40));const zoom=Number(document.querySelector('#zoom').value);up(204);up(205);return zoom})()`);
      assert(pinch > 100, `pinch zoom is ${pinch}%`);
      pass('mobile pinch zoom', `${pinch}%`);
    } catch (error) { fail('mobile pinch zoom', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const release = await evaluate(`(async()=>{
        const scene=document.querySelector('#scene'),dot=document.querySelector('.wire-group[data-id="0001"] .wire-dot'),r=scene.getBoundingClientRect(),sx=r.left+330,sy=r.top+110,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),read=()=>document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d');
        dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:90,pointerType:'touch',button:0,buttons:1,clientX:sx,clientY:sy}));dot.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:90,pointerType:'touch',button:0,buttons:0,clientX:sx,clientY:sy}));dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:91,pointerType:'touch',button:0,buttons:1,clientX:sx,clientY:sy}));
        scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:91,button:0,buttons:1,clientX:sx+132,clientY:sy+44}));
        await wait(120);
        scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:91,button:0,buttons:0,clientX:sx+132,clientY:sy+44}));
        const samples=[];for(let i=0;i<8;i++){await wait(100);samples.push(read())}
        return {unique:new Set(samples).size,moved:JSON.parse(localStorage.getItem('wires-v2')).wires.find(w=>w.id==='0001').x===10};
      })()`);
      assert(release.moved, 'drag did not commit x=10');
      assert(release.unique >= 3, `release produced only ${release.unique} unique geometries`);
      pass('release physics', `${release.unique} geometries after drag release`);
    } catch (error) { fail('release physics', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      await evaluate(`localStorage.setItem('wires-v2',JSON.stringify({version:1,cell:44,background:'#f200e9',pointsMatchBackground:false,gridVisible:true,wires:[{id:'0001',x:7,y:2,length:10,color:'#102cff'},{id:'0002',x:12,y:4,endX:14,endY:4,length:10,color:'#102cff'},{id:'0003',x:16,y:1,length:11,color:'#102cff'}]}));localStorage.setItem('wires-view-v1',JSON.stringify({x:0,y:0,zoom:1}));location.reload()`);
      await sleep(400);
      const pinCollision = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),tail=document.querySelector('.wire-group[data-id="0002"] .wire-tail-hit'),r=scene.getBoundingClientRect(),startX=r.left+14.5*44,startY=r.top+4.5*44,targetX=r.left+7.5*44,targetY=r.top+2.5*44,send=(type,id,cx,cy)=>scene.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:id,pointerType:'touch',button:type==='pointerdown'?0:0,buttons:type==='pointerdown'?1:0,clientX:cx,clientY:cy}));tail.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:210,pointerType:'touch',button:0,buttons:1,clientX:startX,clientY:startY}));tail.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:210,pointerType:'touch',button:0,buttons:0,clientX:startX,clientY:startY}));tail.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:211,pointerType:'touch',button:0,buttons:1,clientX:startX,clientY:startY}));scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:211,pointerType:'touch',button:0,buttons:1,clientX:targetX,clientY:targetY}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:211,pointerType:'touch',button:0,buttons:0,clientX:targetX,clientY:targetY}));await new Promise(resolve=>setTimeout(resolve,80));const w=JSON.parse(localStorage.getItem('wires-v2')).wires,tailWire=w.find(v=>v.id==='0002'),pins=w.filter(v=>v.id!=='0002').flatMap(v=>[[v.x,v.y],...(Number.isFinite(v.endX)?[[v.endX,v.endY]]:[])]);return {tail:[tailWire.endX,tailWire.endY],blocked:tailWire.endX!==7||tailWire.endY!==2,unique:!pins.some(([x,y])=>x===tailWire.endX&&y===tailWire.endY)}})()`);
      assert(pinCollision.blocked && pinCollision.unique, `tail landed on a foreign pin: ${pinCollision.tail}`);
      pass('pin collision', `tail redirected to ${pinCollision.tail.join(',')}`);
    } catch (error) { fail('pin collision', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      await evaluate(`localStorage.setItem('wires-v2',JSON.stringify({version:1,cell:44,background:'#f200e9',pointsMatchBackground:false,gridVisible:true,wires:[{id:'0001',x:7,y:0,length:10,color:'#102cff'},{id:'0002',x:7,y:4,length:0,color:'#102cff'},{id:'0003',x:16,y:1,length:11,color:'#102cff'}]}));localStorage.setItem('wires-view-v1',JSON.stringify({x:0,y:0,zoom:1}));location.reload()`);
      await sleep(700);
      const collisionState = await evaluate("(async()=>{const button=document.querySelector('#collisionToggle'),before=button.textContent.trim(),backgroundBefore=getComputedStyle(button).backgroundColor;button.click();await new Promise(resolve=>setTimeout(resolve,50));return {before,after:button.textContent.trim(),pressed:button.getAttribute('aria-pressed'),backgroundBefore,backgroundAfter:getComputedStyle(button).backgroundColor}})()");
      assert(collisionState.pressed === 'true' && collisionState.before === 'коллизии' && collisionState.after === 'коллизии', `collision label changed with state: ${JSON.stringify(collisionState)}`);
      assert(collisionState.backgroundBefore !== collisionState.backgroundAfter, `collision active fill did not change: ${JSON.stringify(collisionState)}`);
      await sleep(220);
      const bodyCollision = await evaluate(`(()=>{const d=document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d')||'',n=[...d.matchAll(/-?\\d+(?:\\.\\d+)?/g)].map(m=>Number(m[0])),xs=n.filter((_,i)=>i%2===0);return {deflected:xs.slice(1).some(x=>Math.abs(x-330)>2),path:d}})()`);
      assert(bodyCollision.deflected, 'wire body passed through a foreign pin without deflection');
      pass('wire-to-pin collision', 'body deflected around a foreign pin');
      const stability = await evaluate(`(async()=>{const samples=[],clearances=[];for(let frame=0;frame<140;frame++){await new Promise(requestAnimationFrame);const path=document.querySelector('.wire-group[data-id="0001"] .wire-body'),d=path?.getAttribute('d')||'',length=path?.getTotalLength?.()||0;samples.push([...d.matchAll(/-?\\d+(?:\\.\\d+)?/g)].map(match=>Number(match[0])));let minimum=Infinity;for(let offset=0;offset<=length;offset+=2){const point=path.getPointAtLength(offset);minimum=Math.min(minimum,Math.hypot(point.x-330,point.y-198))}clearances.push(minimum)}const deltas=[];for(let i=1;i<samples.length;i++){const count=Math.min(samples[i-1].length,samples[i].length);let max=0;for(let j=0;j<count;j++)max=Math.max(max,Math.abs(samples[i][j]-samples[i-1][j]));deltas.push(max)}const late=deltas.slice(70);const coordinateCount=Math.min(...samples.map(sample=>sample.length));let totalFlips=0,maxFlips=0;for(let coordinate=0;coordinate<coordinateCount;coordinate++){let previousSign=0,coordinateFlips=0;for(let frame=71;frame<samples.length;frame++){const delta=samples[frame][coordinate]-samples[frame-1][coordinate],sign=Math.abs(delta)>.1?Math.sign(delta):0;if(sign&&previousSign&&sign!==previousSign)coordinateFlips++;if(sign)previousSign=sign}totalFlips+=coordinateFlips;maxFlips=Math.max(maxFlips,coordinateFlips)}return {maxLate:Math.max(...late),movingLate:late.filter(delta=>delta>.25).length,frames:late.length,totalFlips,maxFlips,minClearance:Math.min(...clearances.slice(70))}})()`);
      assert(stability.totalFlips < 20 && stability.maxFlips < 3 && stability.minClearance >= 43, `collision reliability remained low: ${JSON.stringify(stability)}`);
      pass('collision settle stability', `${stability.totalFlips} late direction flips; ${stability.maxLate.toFixed(2)}px max displacement; ${stability.minClearance.toFixed(2)}px visible clearance`);
    } catch (error) { fail('wire-to-pin collision', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      await evaluate(`localStorage.setItem('wires-v2',JSON.stringify({version:1,cell:44,background:'#ffffff',pointsMatchBackground:false,gridVisible:true,wires:[{id:'0001',x:3,y:2,length:8,color:'#102cff'},{id:'0002',x:4,y:2,length:8,color:'#00d99b'},{id:'0003',x:5,y:2,length:8,color:'#f200e9'},{id:'0004',x:6,y:2,length:8,color:'#ffc642'},{id:'0005',x:7,y:2,length:8,color:'#102cff'}]}));localStorage.setItem('wires-view-v1',JSON.stringify({x:0,y:0,zoom:1}));location.reload()`);
      await sleep(1000);
      const crowded = await evaluate(`(()=>{let maxDrift=0;for(const w of JSON.parse(localStorage.getItem('wires-v2')).wires){const d=document.querySelector('.wire-group[data-id="'+w.id+'"] .wire-body')?.getAttribute('d')||'',n=[...d.matchAll(/-?\\d+(?:\\.\\d+)?/g)].map(m=>Number(m[0])),xs=n.filter((_,i)=>i%2===0),expected=(w.x+.5)*44;for(const x of xs)maxDrift=Math.max(maxDrift,Math.abs(x-expected))}return {maxDrift}})()`);
      assert(crowded.maxDrift < 2.5, `adjacent pins caused ${crowded.maxDrift.toFixed(2)}px lateral drift`);
      pass('adjacent pin stability', `${crowded.maxDrift.toFixed(2)}px maximum lateral drift`);
    } catch (error) { fail('adjacent pin stability', error); }

    await evaluate("localStorage.clear(); location.reload();");
    const failed = results.filter(result => result.error);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  } finally {
    try { socket?.close(); } catch {}
    if (chrome?.exitCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(1500)]);
      if (chrome.exitCode === null) {
        chrome.kill('SIGKILL');
        await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(500)]);
      }
    }
    if (server?.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(1000)]);
    }
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}

main().catch(error => { console.error(`FATAL: ${error.stack || error}`); process.exitCode = 1; });
