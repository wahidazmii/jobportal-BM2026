/**
 * Tailwind CSS configuration for PT Buana Megah Job Portal.
 *
 * Content scanning:
 *   - All Nunjucks templates under src/views/**\/*.njk
 *   - All vendored / project JS under src/public/js/**\/*.js
 *
 * Output:
 *   - src/public/css/app.css (built via `npm run build:assets`)
 *
 * Validates: Requirements 2.10, 1.1 (Design §3, §4.3)
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/views/**/*.njk', './src/public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          900: '#1e3a8a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
