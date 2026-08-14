import { JSDOM } from 'jsdom'
import fs from 'fs'

const dist = '/root/music/local/unstream-main/frontend/dist'
const html = fs.readFileSync(dist + '/index.html', 'utf8')
const dom = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true })
const { window } = dom
global.window = window
global.document = window.document
global.self = window
global.HTMLElement = window.HTMLElement
global.Element = window.Element
global.Node = window.Node
global.getComputedStyle = window.getComputedStyle
global.localStorage = window.localStorage
global.location = window.location
window.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} })
window.scrollTo = () => {}
window.requestAnimationFrame = (cb)=>setTimeout(()=>cb(Date.now()),0)
window.cancelAnimationFrame = (id)=>clearTimeout(id)
window.open = () => null

global.MutationObserver = window.MutationObserver
global.customElements = window.customElements
global.DocumentFragment = window.DocumentFragment
global.SVGElement = window.SVGElement
global.EventListener = window.EventListener
window.HTMLElement.prototype.setPointerCapture = window.HTMLElement.prototype.setPointerCapture || function(){}

const errors = []
window.addEventListener('error', e => errors.push('ERROR: ' + (e.error?.stack || e.message)))
window.onerror = (m,s,l,c,err) => errors.push('ONERROR: ' + (err?.stack || m))

const jsFile = fs.readdirSync(dist + '/assets').find(f=>f.startsWith('index-')&&f.endsWith('.js'))
const mod = 'file://' + dist + '/assets/' + jsFile
try {
  await import(mod)
} catch (e) {
  errors.push('IMPORT THROW: ' + (e.stack || e.message))
}

setTimeout(() => {
  const root = window.document.getElementById('root')
  console.log('=== ROOT innerHTML length:', root ? root.innerHTML.length : 'NO ROOT')
  console.log('=== ROOT first 300:', root ? root.innerHTML.slice(0,300) : '')
  console.log('=== ERRORS (' + errors.length + ') ===')
  errors.slice(0,8).forEach(e => console.log(e.slice(0,900)))
  process.exit(0)
}, 2000)
