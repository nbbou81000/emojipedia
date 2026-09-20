name: 1. Construire l'index des emojis (one-shot)

# Lancement manuel uniquement : onglet Actions -> ce workflow -> bouton "Run workflow".
# A relancer seulement quand Unicode publie une nouvelle version d'emojis (une fois par an).

on:
  workflow_dispatch:
    inputs:
      commit:
        description: "Enregistrer le resultat dans le depot"
        type: boolean
        default: true

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Recuperer le depot
        uses: actions/checkout@v4

      - name: Installer Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Telecharger les traces OpenMoji (noir)
        run: |
          curl -sL -o openmoji.zip \
            https://github.com/hfg-gmuend/openmoji/releases/latest/download/openmoji-svg-black.zip
          mkdir -p openmoji-black
          unzip -oq openmoji.zip -d openmoji-black
          echo "Fichiers SVG disponibles : $(ls openmoji-black | wc -l)"

      - name: Construire l'index
        run: node scripts/build-index.mjs

      - name: Resume
        run: |
          echo "### Index construit" >> $GITHUB_STEP_SUMMARY
          node -e "
            const i = require('./data/emoji-index.json');
            const c = i.counts;
            console.log('- Emojis : ' + c.total);
            console.log('- Traces SVG : ' + c.with_svg);
            console.log('- Sans nom francais : ' + c.without_name_fr);
            for (const [g, n] of Object.entries(c.by_group)) console.log('  - ' + g + ' : ' + n);
          " >> $GITHUB_STEP_SUMMARY

      - name: Enregistrer dans le depot
        if: inputs.commit
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data assets
          if git diff --staged --quiet; then
            echo "Rien de nouveau."
          else
            git commit -m "Index des emojis : $(node -p "require('./data/emoji-index.json').counts.total") entrees"
            git push
          fi
                                                                 
