import { defineConfig } from 'vite';

// Déployé sous https://paul-laurent.fr/scrabble/
// `base` relatif pour que le sous-répertoire fonctionne sans réécriture serveur.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
});
