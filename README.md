# Centurion Scrabble

Scrabble français jouable dans le navigateur contre une IA à cinq niveaux,
ou à deux en liaison directe. La partie solo ne fait aucun appel réseau une
fois la page chargée.

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
sous-répertoire voulu, en l’occurrence `paul-laurent.fr/centurion-scrabble/`.
Un `.htaccess` active la compression (le dictionnaire passe de 304 à ~180 Ko)
et le cache long sur les fichiers empreintés.

Le même bundle convient à GitHub Pages, servi sous `/centurion-scrabble/` —
d'où l'intérêt de ne jamais repasser à une base absolue.

## Partie à deux

Aucun serveur de jeu : les deux navigateurs se relient en WebRTC. L'hôte crée
une partie, obtient un code à six caractères et transmet le lien
`…/#partie=CODE` ; l'invité l'ouvre, ou saisit le code.

L'hôte fait autorité — il détient le sac et les deux chevalets, valide les
coups et diffuse l'état après chaque tour. L'invité n'envoie que des
intentions, et ne reçoit jamais le chevalet adverse. Les instantanés sont
exprimés du point de vue du destinataire, qui s'y voit toujours en position 0.

La mise en relation initiale passe par le courtier public de PeerJS, qui ne
voit transiter que l'identifiant de la partie : l'hébergement peut donc rester
entièrement statique. Revers de la médaille, ce courtier est un tiers, et
certains réseaux d'entreprise bloquent WebRTC.

## Dictionnaire

Le lexique par défaut compte 311 495 formes, dérivé de Dicollecte via
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
| `src/core/game.js` | sac, chevalets, tours, fin de partie, instantanés |
| `src/net/session.js` | liaison directe entre deux navigateurs |
| `src/ui/app.js` | rendu et saisie |
| `tools/build-dict.mjs` | construction du DAWG minimal |
