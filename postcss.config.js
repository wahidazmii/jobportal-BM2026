/**
 * PostCSS pipeline for the Tailwind-built stylesheet.
 *
 * Validates: Requirements 2.10, 1.1 (Design §3)
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
