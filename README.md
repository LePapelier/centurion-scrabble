# Centurion Scrabble

Scrabble français jouable dans le navigateur contre une IA à cinq niveaux.
Tout tourne en local : aucun appel réseau une fois la page chargée.

## Commandes

```bash
npm install
npm run dev          # serveur de développement
npm run build        # bundle de production dans dist/
npm run build:dict   # régénère public/dict/fr.dawg
```

Vérifications :

```bash
node tools/check-dict.mjs   # le DAWG contient exactement le lexique attendu
node tools/simulate.mjs 20  # 140 parties IA contre IA, tous niveaux
```

## Déploiement

`base` vaut `./` : le contenu de `dist/` se copie tel quel dans le
sous-répertoire voulu, par exemple `paul-laurent.fr/scrabble/`. Un
`.htaccess` active la compression (le dictionnaire passe de 304 à ~180 Ko)
et le cache long sur les fichiers empreintés.

## Dictionnaire

Le lexique par défaut compte 311 509 formes, dérivé de Dicollecte via
`an-array-of-french-words` (MIT), filtré aux mots jouables : 2 à 15 lettres,
accents retirés, noms propres exclus. Ce n'est pas l'ODS, qui est une base
protégée et non redistribuable.

Pour utiliser une liste personnelle — un fichier d'un mot par ligne :

```bash
npm run build:dict -- /chemin/vers/liste.txt
```

`data/supplement.txt` (ajouts) et `data/exclusions.txt` (retraits) sont
appliqués en plus, s'ils existent.

## Organisation

| Chemin | Rôle |
| --- | --- |
| `src/core/dawg.js` | lecture de l'automate binaire |
| `src/core/generator.js` | énumération des coups légaux (Appel & Jacobson) |
| `src/core/ai.js` | valeur du reliquat et choix du coup selon le niveau |
| `src/core/game.js` | sac, chevalets, tours, fin de partie |
| `src/ui/app.js` | rendu et saisie |
| `tools/build-dict.mjs` | construction du DAWG minimal |
