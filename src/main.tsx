import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './products.css'
import './themes.css'
import './characters.css'
import './dark.css'
import './design.css'

try {
  document.documentElement.dataset.theme=window.localStorage.getItem('frame-studio-theme')==='light'?'light':'dark'
} catch { document.documentElement.dataset.theme='dark' }

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
