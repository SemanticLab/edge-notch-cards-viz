# edge-notch-cards-viz

Interactive visualizations of a digitized **edge-notch card** deck (McBee Keysort and
kin), published as a static GitHub Pages site.

## Demos

| Page | What it shows |
| --- | --- |
| [`index.html`](index.html) | Landing page linking to all demos. |
| [`position_explorer.html`](position_explorer.html) | Hover a notch position to reveal the categories it encodes; paired positions light up in matching colors. |
| [`category_explorer.html`](category_explorer.html) | Hover a category (field, state, surname letter) to watch its slots notch in on a blank card. |
| [`sort_demo.html`](sort_demo.html) | 3D animation of the mechanical needle-and-lift sort, round after round. |
| [`sort_explorer.html`](sort_explorer.html) | Filter the full deck by notch position or category and see which cards fall out. |

## Shared assets

- `edge_notch_card.js` — the card-diagram component used by the explorers.
- `cards_demo.json` — packed deck data (notches + the fields the labels render) used by the sort demos.
- `notch_decoding.json` — the decoded position→category map used by the explorers.

`sort_demo.html` also loads [three.js](https://threejs.org/) and
[poly2tri](https://github.com/r3mi/poly2tri.js) from a CDN.

## Running locally

The pages fetch JSON, so they must be served over HTTP (opening the files directly off
disk will fall back to a small inline dataset, or fail to load the deck). From the repo
root:

```sh
python3 -m http.server 8000
```

then visit <http://localhost:8000/>.

## Publishing

This is a plain static site — no build step. Enable GitHub Pages with
**Settings → Pages → Deploy from a branch → `main` / root**. The `.nojekyll` file tells
Pages to serve the files as-is without Jekyll processing.
