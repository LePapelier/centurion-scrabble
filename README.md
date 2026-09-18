# Centurion Scrabble

Scrabble français jouable dans le navigateur contre une IA à cinq niveaux,
ou à deux en liaison directe. La partie solo ne fait aucun appel réseau une
fois la page chargée.

## Commandes

```bash
npm install
npm run dev          # serveur de développement
npm run build        # bundle de production dans dist/
npm run dict:fetch   # récupère le lexique source (8,9 Mo, hors dépôt)
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
Un `.htaccess` active la compression (le dictionnaire passe de 732 à ~440 Ko)
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

Le lexique compte 641 239 formes, filtré aux mots jouables : 2 à 15 lettres,
accents retirés, noms propres exclus.

Sa source est **Morphalou 3.1** (ATILF/CNRS), sous licence **LGPL-LR**, dans
la version déjà dégrossie pour le jeu par
[`french-fr-fr-morphalou`](https://github.com/FredrikBorgstrom/french-fr-fr-morphalou)
(LGPL-LR également). Le dictionnaire binaire livré dans `public/dict/` en est
un dérivé, distribué sous la même licence.

> Source : ATILF/CNRS, *Morphalou 3.1*,
> <https://hdl.handle.net/11403/morphalou/v3.1>

La liste pèse 8,9 Mo : le dépôt embarque sa provenance plutôt que son
contenu. `npm run dict:fetch` récupère le commit épinglé, vérifie l'empreinte
SHA-256 du fichier et refuse tout écart. Sans elle, `build:dict` se replie sur
le lexique réduit embarqué (`an-array-of-french-words`, MIT, 311 495 formes)
et le signale.

Ce n'est pas l'ODS, qui est une base protégée : tout produit numérique
conforme à l'ODS suppose une licence auprès de Larousse. Morphalou est un
lexique de langue, pas une liste de Scrabble — il diverge dans les deux sens.
`data/supplement.txt` (ajouts) et `data/exclusions.txt` (retraits) rattrapent
l'écart au fil des parties ; ils sont appliqués dans tous les cas.

Pour utiliser une liste personnelle — un fichier d'un mot par ligne :

```bash
npm run build:dict -- /chemin/vers/liste.txt
```

## Organisation

| Chemin | Rôle |
| --- | --- |
| `src/core/dawg.js` | lecture de l'automate binaire |
| `src/core/generator.js` | énumération des coups légaux (Appel & Jacobson) |
| `src/core/ai.js` | valeur du reliquat et choix du coup selon le niveau |
| `src/core/game.js` | sac, chevalets, tours, fin de partie, instantanés |
| `src/net/session.js` | liaison directe entre deux navigateurs |
| `src/ui/app.js` | rendu et saisie |
| `tools/fetch-morphalou.mjs` | récupération du lexique source, à empreinte vérifiée |
| `tools/build-dict.mjs` | construction du DAWG minimal |
