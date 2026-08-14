import { JSDOM } from 'jsdom'
import fs from 'fs'

const dist = '/root/music/local/unstream-main/frontend/dist'
const html = fs.readFileSync(dist + '/index.html', 'utf8')
const dom = new JSDOM(html, { url: 'http://localhost:8080/?q=afro%20house', pretendToBeVisual: true })
const { window } = dom
for (const k of ['window','document','navigator','self','HTMLElement','Element','Node','getComputedStyle','localStorage','location','MutationObserver','customElements','DocumentFragment','SVGElement','EventListener']) {
  if (k === 'navigator') continue
  global[k] = window[k]
}
window.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} })
window.scrollTo = () => {}
window.requestAnimationFrame = (cb)=>setTimeout(()=>cb(Date.now()),0)
window.cancelAnimationFrame = (id)=>clearTimeout(id)
window.open = () => null
window.HTMLElement.prototype.setPointerCapture = window.HTMLElement.prototype.setPointerCapture || function(){}

const errors = []
window.addEventListener('error', e => errors.push('ERROR: ' + (e.error?.stack || e.message)))
window.onerror = (m,s,l,c,err) => errors.push('ONERROR: ' + (err?.stack || m))

const jsFile = fs.readdirSync(dist + '/assets').find(f=>f.startsWith('index-')&&f.endsWith('.js'))
try { await import('file://' + dist + '/assets/' + jsFile) }
catch (e) { errors.push('IMPORT THROW: ' + (e.stack || e.message)) }

setTimeout(() => {
  const root = window.document.getElementById('root')
  console.log('=== ROOT innerHTML length:', root ? root.innerHTML.length : 'NO ROOT')
  // look for results text
  const txt = window.document.body.innerText || ''
  console.log('=== body has "Results for"? ', txt.includes('Results for'))
  console.log('=== body has "afro"? ', /afro/i.test(txt))
  console.log('=== ERRORS (' + errors.length + ') ===')
  errors.slice(0,10).forEach(e => console.log(e.slice(0,1000)))
  process.exit(0)
}, 3000)
