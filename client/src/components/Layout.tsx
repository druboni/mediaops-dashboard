import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'

export default function Layout() {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex h-screen bg-gray-950 text-white">
      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 h-12 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-3">
        <button
          onClick={() => setOpen(true)}
          className="text-gray-400 hover:text-white p-1 -ml-1"
          aria-label="Open menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="font-bold text-white tracking-tight">MediaOps</span>
      </div>

      {/* Backdrop */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60"
          onClick={() => setOpen(false)}
        />
      )}

      <Sidebar open={open} onClose={() => setOpen(false)} />

      <main className="flex-1 lg:ml-56 overflow-y-auto pt-12 lg:pt-0">
        <Outlet />
      </main>
    </div>
  )
}
