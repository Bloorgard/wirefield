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
      const result = await evaluate(`(()=>({groups:document.querySelectorAll('.wire-group').length,rendered:[...document.querySelectorAll('.wire-body')].every(e=>Boolean(e.getAttribute('d'))),ids:[...document.querySelectorAll('.wire-group')].map(e=>e.dataset.id)}))()`);
      assert(result.groups === 3, `expected 3 groups, got ${result.groups}`);
      assert(result.rendered, 'one or more SVG paths has no d attribute');
      assert(result.ids.join(',') === '0001,0002,0003', `unexpected IDs ${result.ids.join(',')}`);
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
      const collapsed = await evaluate(`(()=>{const side=document.querySelector('.side'),button=document.querySelector('#layersToggle'),list=document.querySelector('#list');return {height:parseFloat(getComputedStyle(side).height),button:getComputedStyle(button).display,list:getComputedStyle(list).display}})()`);
      assert(collapsed.height <= 120, `collapsed panel is ${collapsed.height}px`);
      assert(collapsed.button !== 'none', 'mobile layers button is hidden');
      assert(collapsed.list === 'none', 'mobile layer list is open by default');
      const expanded = await evaluate(`(()=>{const b=document.querySelector('#layersToggle');b.click();return {open:document.querySelector('.side').classList.contains('layers-open'),list:getComputedStyle(document.querySelector('#list')).display}})()`);
      assert(expanded.open && expanded.list === 'block', 'mobile layers panel did not open');
      await evaluate("document.querySelector('#layersToggle').click()");
      pass('mobile layers panel', `${collapsed.height}px collapsed, toggle opens list`);
    } catch (error) { fail('mobile layers panel', error); }

    try {
      await setViewport(1280, 800, false);
      await reset();
      const release = await evaluate(`(async()=>{
        const scene=document.querySelector('#scene'),body=document.querySelector('.wire-group[data-id="0001"] .wire-body'),r=scene.getBoundingClientRect(),sx=r.left+330,sy=300,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),read=()=>document.querySelector('.wire-group[data-id="0001"] .wire-body')?.getAttribute('d');
        body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:91,button:0,buttons:1,clientX:sx,clientY:sy}));
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
    await rm(profile, {recursive: true, force: true});
  }
}

main().catch(error => { console.error(`FATAL: ${error.stack || error}`); process.exitCode = 1; });
