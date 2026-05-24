/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
      },
      boxShadow: {
        'soft':   '0 1px 2px rgba(15,23,42,0.04), 0 2px 8px rgba(15,23,42,0.04)',
        'card':   '0 1px 2px rgba(15,23,42,0.05), 0 4px 14px rgba(15,23,42,0.06)',
        'lift':   '0 6px 24px -8px rgba(99,102,241,0.25), 0 2px 8px rgba(15,23,42,0.06)',
        'drag':   '0 18px 40px -10px rgba(15,23,42,0.22), 0 2px 12px rgba(15,23,42,0.10)',
      },
      animation: {
        'fade-in':  'fadeIn 220ms ease-out both',
        'slide-up': 'slideUp 280ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'pop':      'pop 200ms ease-out both',
        'pulse-soft': 'pulseSoft 2.4s ease-in-out infinite',
      },
      keyframes: {
        fadeIn:  { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        slideUp: { '0%': { opacity: 0, transform: 'translateY(8px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        pop:     { '0%': { transform: 'scale(0.96)', opacity: 0 }, '100%': { transform: 'scale(1)', opacity: 1 } },
        pulseSoft: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.6 } },
      },
    },
  },
  plugins: [],
};
