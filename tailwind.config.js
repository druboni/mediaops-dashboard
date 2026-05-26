/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(${name}) / <alpha-value>)`
const scale = (prefix, shades) => Object.fromEntries(shades.map(n => [n, v(`--c-${prefix}-${n}`)]))

export default {
  content: ['./client/index.html', './client/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // All themed shades are driven by CSS custom properties set per data-theme.
        // Opacity variants (e.g. bg-blue-900/60) are generated automatically.
        gray:   scale('gray',   [100,200,300,400,500,600,700,800,900,950]),
        blue:   scale('blue',   [200,300,400,500,600,700,800,900,950]),
        green:  scale('green',  [300,400,900]),
        red:    scale('red',    [300,400,500,900]),
        yellow: scale('yellow', [300,400,500,900]),
        purple: scale('purple', [300,400,500,900]),
        orange: scale('orange', [300,400,900]),
        violet: scale('violet', [300,400,900]),
      },
      keyframes: {
        shimmer: {
          '0%':   { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
      },
      animation: { shimmer: 'shimmer 1.5s linear infinite' },
    },
  },
  plugins: [],
}
