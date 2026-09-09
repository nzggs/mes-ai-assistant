/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        mes: {
          bg: '#f7f7f8',
          sidebar: '#ffffff',
          border: '#e5e5e5',
          primary: '#4d6bfe',
          primaryHover: '#3d5bf0',
          text: '#1a1a1a',
          textSecondary: '#6b6b6b',
          textTertiary: '#999999',
          userBubble: '#4d6bfe',
          aiBubble: '#ffffff',
          tagBg: '#f0f2ff',
          tagText: '#4d6bfe',
          success: '#22c55e',
          warning: '#f59e0b',
          danger: '#ef4444',
          info: '#3b82f6',
        }
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'blink': 'blink 1s infinite',
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'expand': 'expand 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        expand: {
          '0%': { maxHeight: '0', opacity: '0' },
          '100%': { maxHeight: '1000px', opacity: '1' },
        },
      }
    },
  },
  plugins: [],
}
