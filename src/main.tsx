import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 版本标识：便于在浏览器 Console 确认加载的是否为最新构建（F12 输入 __MES_APP_VERSION）
;(globalThis as any).__MES_APP_VERSION = '20260811-1527'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
