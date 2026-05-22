import { createContext, useContext, useEffect, useState } from 'react'

export type Theme = 'default' | 'cyberpunk'

export const THEMES: { id: Theme; label: string; accent: string }[] = [
  { id: 'default',   label: 'Default',   accent: '#3b82f6' },
  { id: 'cyberpunk', label: 'Cyberpunk', accent: '#FCE303' },
]

const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: 'default',
  setTheme: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem('theme')
    return (stored === 'default' || stored === 'cyberpunk') ? stored : 'default'
  })

  const setTheme = (t: Theme) => {
    setThemeState(t)
    localStorage.setItem('theme', t)
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>
}

export const useTheme = () => useContext(Ctx)
