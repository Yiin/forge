import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './routes'
import './app.css'
import './styles.css'
import { readTheme, resolveTheme } from './lib/shell-storage'
document.documentElement.dataset.theme = resolveTheme(readTheme())
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
