#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const URL = process.env.WIRES_URL || 'http://127.0.0.1:8765/index.html';
const CHROME = process.env.CHROME_BIN || '/home/hermesbot/.cache/ms-playwright/chromium-1234/chrome-linux/chrome';
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
      const response = await fetch(URL);
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
      await cdp('Page.navigate', {url: URL});
      await sleep(350);
      await waitFor(async () => (await evaluate('document.readyState')) === 'complete');
    };
    const reset = async () => {
      await evaluate("localStorage.clear(); location.reload();");
      await sleep(350);
      await waitFor(async () => (await evaluate('document.readyState')) === 'complete');
    };
    const setViewport = async (width, height, mobile) => {
      await cdp('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile});
    };
    const state = () => evaluate("JSON.parse(localStorage.getItem('wires-v2'))");

    await setViewport(1280, 800, false);
    await navigate();
    try {
      const result = await evaluate(`(()=>({groups:document.querySelectorAll('.wire-group').length,rendered:[...document.querySelectorAll('.wire-body')].every(e=>Boolean(e.getAttribute('d'))),ids:[...document.querySelectorAll('.wire-group')].map(e=>e.dataset.id),collisionButton:Boolean(document.querySelector('#collisionToggle')),collisionOff:document.querySelector('#collisionToggle')?.getAttribute('aria-pressed')==='false'}))()`);
      assert(result.groups === 3, `expected 3 groups, got ${result.groups}`);
      assert(result.rendered, 'one or more SVG paths has no d attribute');
      assert(result.ids.join(',') === '0001,0002,0003', `unexpected IDs ${result.ids.join(',')}`);
      assert(result.collisionButton && result.collisionOff, 'collision mode is not off by default');
      pass('fresh render', '3 groups with SVG geometry');
    } catch (error) { fail('fresh render', error); }

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
      await evaluate("document.querySelector('#deleteBtn').click()");
      assert((await state()).wires.length === 3, 'delete did not restore three wires');
      pass('add and delete');
    } catch (error) { fail('add and delete', error); }

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
      const clipboard = await evaluate(`(async()=>{Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.querySelector('#codeBtn').click();document.querySelector('#copyBtn').click();await new Promise(resolve=>setTimeout(resolve,100));return document.querySelector('#toast').textContent})()`);
      assert(clipboard === 'Код скопирован' || clipboard === 'Не удалось скопировать код', `unexpected clipboard feedback: ${clipboard}`);
      pass('clipboard fallback feedback', clipboard);
    } catch (error) { fail('clipboard fallback feedback', error); }

    try {
      await setViewport(390, 844, true);
      await reset();
      const collapsed = await evaluate(`(()=>{const side=document.querySelector('.side'),button=document.querySelector('#layersToggle'),list=document.querySelector('#list'),quick=document.querySelector('#compactLayerControls'),range=quick?.querySelector('input'),swatches=quick?.querySelectorAll('.swatch');return {height:parseFloat(getComputedStyle(side).height),button:getComputedStyle(button).display,list:getComputedStyle(list).display,quick:getComputedStyle(quick).display,range:Boolean(range),swatches:swatches?.length||0,toolDirection:getComputedStyle(document.querySelector('.tool-controls')).flexDirection,actionDirection:getComputedStyle(document.querySelector('.top-actions')).flexDirection}})()`);
      assert(collapsed.height >= 145 && collapsed.height <= 170, `collapsed panel is ${collapsed.height}px`);
      assert(collapsed.button !== 'none', 'mobile layers button is hidden');
      assert(collapsed.list === 'none', 'mobile layer list is open by default');
      assert(collapsed.quick === 'block' && collapsed.range && collapsed.swatches === 6, 'compact layer controls are incomplete');
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
      const commandPoints = await evaluate(`(async()=>{const scene=document.querySelector('#scene'),hitA=document.querySelector('.wire-group[data-id="0001"] .wire-hit'),hitB=document.querySelector('.wire-group[data-id="0003"] .wire-hit'),r=scene.getBoundingClientRect(),ax=r.left+330,ay=r.top+110,bx=r.left+726,by=r.top+66;hitA.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:230,pointerType:'mouse',button:0,buttons:1,metaKey:true,clientX:ax,clientY:ay}));hitB.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:231,pointerType:'mouse',button:0,buttons:1,metaKey:true,clientX:bx,clientY:by}));const selected={a:document.querySelector('.wire-group[data-id="0001"] .wire-dot').classList.contains('point-selected'),b:document.querySelector('.wire-group[data-id="0003"] .wire-dot').classList.contains('point-selected')};const dot= document.querySelector('.wire-group[data-id="0003"] .wire-dot');dot.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:232,pointerType:'mouse',button:0,buttons:1,clientX:bx,clientY:by}));scene.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:232,pointerType:'mouse',button:0,buttons:1,clientX:bx+44,clientY:by}));scene.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:232,pointerType:'mouse',button:0,buttons:0,clientX:bx+44,clientY:by}));await new Promise(resolve=>setTimeout(resolve,100));const wires=JSON.parse(localStorage.getItem('wires-v2')).wires;return {selected,moved:wires.find(w=>w.id==='0001').x===8&&wires.find(w=>w.id==='0003').x===17}})()`);
      assert(commandPoints.selected.a && commandPoints.selected.b, 'Command click did not add both point selections');
      assert(commandPoints.moved, 'Command-selected points did not move together');
      pass('Command point selection', 'Mac modifier selects and drags multiple points');
    } catch (error) { fail('Command point selection', error); }

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
      await setViewport(390, 844, true);
      await reset();
      const gravity = await evaluate(`(async()=>{if(!('DeviceMotionEvent' in window))window.DeviceMotionEvent=function(){};if(!('DeviceOrientationEvent' in window))window.DeviceOrientationEvent=function(){};const button=document.querySelector('#gravityToggle'),before=document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d');button.click();await new Promise(resolve=>setTimeout(resolve,300));const event=new Event('devicemotion');Object.defineProperty(event,'accelerationIncludingGravity',{value:{x:9.81,y:0,z:0}});window.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,180));const changed=before!==document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d');const onPressed=button.getAttribute('aria-pressed');button.click();await new Promise(resolve=>setTimeout(resolve,40));const offPressed=button.getAttribute('aria-pressed');window.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,80));return {pressed:onPressed,changed,offPressed}})()`);
      assert(gravity.pressed === 'true', 'gravity toggle did not activate');
      assert(gravity.changed, 'device motion did not wake wire physics');
      assert(gravity.offPressed === 'false', 'gravity toggle did not deactivate');
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
      await evaluate("document.querySelector('#collisionToggle').click()");
      await sleep(220);
      const bodyCollision = await evaluate(`(()=>{const d=document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d')||'',n=[...d.matchAll(/-?\\d+(?:\\.\\d+)?/g)].map(m=>Number(m[0])),xs=n.filter((_,i)=>i%2===0);return {deflected:xs.slice(1).some(x=>Math.abs(x-330)>2),path:d}})()`);
      assert(bodyCollision.deflected, 'wire body passed through a foreign pin without deflection');
      pass('wire-to-pin collision', 'body deflected around a foreign pin');
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

    const errors = await evaluate('[]');
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
