# Music Catalog

An Obsidian plugin for cataloging your vinyl record and CD collection. Scan UPC barcodes or search by title, artist, label, composer, and conductor to automatically pull metadata from Discogs and MusicBrainz, then save a structured note for each release directly in your vault.

![Music Catalog demo](demo.gif)

## Features

- **Barcode scanning** — scan UPC barcodes with a USB or Bluetooth barcode scanner; the code is captured instantly as if typed into the input field
- **Manual search** — search by title and any combination of artist, label, composer, and conductor when no barcode is available
- **Classical / opera / soundtrack support** — composer and conductor fields run as separate queries and results are merged, surfacing specific pressings of heavily-recorded works
- **Format filtering** — filter search results to CD Only or LP Only before searching
- **Automatic metadata** — album title, artists, label, catalog number, release year, genre, format, and cover art are fetched automatically
- **Condition tracking** — record physical condition using standard vinyl collector grades: Mint (M), Near Mint (NM), Very Good Plus (VG+), Very Good (VG), Good Plus (G+), Good (G), Fair (F), Poor (P)
- **Copies tracking** — track how many copies of a release you own; if you scan a duplicate, the plugin detects it and offers to update the copy count rather than creating a duplicate note
- **Valuation** — record the estimated value of each release
- **Acquisition date** — defaults to today, editable before saving
- **Save & Add Another** — save a release and immediately scan the next without closing the modal, useful for cataloging a large batch
- **Catalog view** — a dedicated ribbon icon opens the Music Catalog base table view directly
- **Obsidian Bases integration** — automatically creates and manages a `.base` file with four pre-configured table views: All Releases, By Year, By Artist, and Needs Condition
- **Vault reorganization** — a built-in tool scans your entire vault for release notes (by tag) and moves them to your configured folder, regardless of where they currently live
- **iOS compatible** — notes and the Base table view sync to iOS via Obsidian Sync and are fully readable on mobile (plugin features require desktop)

## Installation

### From the Obsidian Community Plugin Store (recommended)

1. Open Obsidian Settings → Community plugins
2. Turn off Restricted mode if prompted
3. Click **Browse** and search for **Music Catalog**
4. Click **Install**, then **Enable**

### Manual installation

1. Download the latest release from the [GitHub releases page](https://github.com/jimparrillo/obsidian-music-catalog/releases)
2. Copy `main.js` and `manifest.json` into a folder called `music-catalog` inside your vault's `.obsidian/plugins/` directory
3. Reload Obsidian and enable the plugin in Settings → Community plugins

## Setup

### 1. Configure your folders

Go to **Settings → Music Catalog** and set:

- **Catalog folder** — where `Music Catalog.base` will be created (e.g. `Music` or `03 Resources/Music`)
- **Notes subfolder** — subfolder inside the catalog folder for individual release notes (e.g. `Notes`); leave blank to store notes directly in the catalog folder

### 2. Create the Base file

Click **Create Base File** in settings. This creates `Music Catalog.base` at your configured path with all four table views pre-configured. You need [Obsidian Bases](https://obsidian.md/bases) enabled (available in Obsidian v1.8+).

### 3. Optional: Discogs personal access token

MusicBrainz is available with no setup required. For richer metadata — pressing details, catalog numbers, and cover art — add a Discogs personal access token:

1. Log into [discogs.com](https://www.discogs.com)
2. Click your username → **Settings** → **Developers**
3. Click **Generate new token**
4. Paste the token into **Settings → Music Catalog → API → Discogs personal access token**

> **Important:** Use a Personal Access Token, not a Consumer Key or Consumer Secret. Those are for OAuth and will not work here.

When a Discogs token is configured, it is used as the primary source. MusicBrainz is always used as a fallback.

## Usage

### Adding a release by barcode

1. Click the **disc icon** in the left ribbon, or use the command palette → **Add music**
2. The modal opens with focus in the barcode field — scan or type a UPC
3. Press Enter or click **Look Up Release**
4. Review the metadata preview, set condition, copies, acquisition date, and value
5. Click **Save Release** to create the note, or **Save & Add Another** to save and immediately scan the next item

### Adding a release by title search

1. Open the Add Music modal and click the **Search by Title** tab
2. Enter a title (required) and optionally any combination of Artist, Label, Format filter, Composer, and Conductor
3. Click **Search Releases** — results appear inline below the form
4. Click any result card to proceed to the confirm step

### Searching for classical, opera, and soundtracks

For works with many recordings — Beethoven symphonies, Verdi operas, film soundtracks — use the fields under the **Classical / Opera / Soundtrack** divider:

- **Composer** — e.g. `Verdi`
- **Conductor** — e.g. `Muti`
- **Artist** — e.g. `Caballé`
- **Label** — e.g. `Angel`

Each non-empty artist term (Artist, Composer, Conductor) runs as a separate query. Results are merged and deduplicated, so filling in multiple fields expands rather than narrows the search. Use the **LP Only** or **CD Only** format filter to reduce noise when you know the format.

### Viewing the catalog

Click the **music note icon** in the left ribbon to open the Music Catalog table view directly.

### Handling duplicates

If you scan a release that already exists in your catalog, the plugin shows the existing entry with the current copy count and offers to update it rather than creating a duplicate.

## Note format

Each release is saved as a Markdown file with YAML frontmatter:

```yaml
---
album: "Kind of Blue"
artists: ["Miles Davis"]
label: "Columbia"
catalogNumber: "CL 1355"
releaseYear: 1959
genre: ["Jazz", "Modal"]
format: "12\" Vinyl"
upc: ""
cover: "https://..."
condition: "Near Mint (NM)"
acquired: "2026-03-16"
valuation: 45
copies: 1
tags: ["record"]
---
```

Followed by a cover image (when available from Discogs) and a `## Notes` section for personal annotations.

## Condition grades

| Grade | Description |
|-------|-------------|
| Mint (M) | Perfect, unplayed |
| Near Mint (NM) | Nearly perfect, minimal signs of handling |
| Very Good Plus (VG+) | Shows some signs of play but still excellent |
| Very Good (VG) | Noticeable surface marks, plays through cleanly |
| Good Plus (G+) | Heavy marks, plays with noise |
| Good (G) | Very heavy marks, plays throughout |
| Fair (F) | Severely damaged, plays with difficulty |
| Poor (P) | Barely playable |

## Reorganizing existing notes

If you change your folder settings after adding releases, use **Settings → Reorganize Files → Scan Vault & Reorganize**. The tool scans your entire vault for notes tagged `#record`, shows you what it found and where, then moves everything to the correct location after you confirm.

## Limitations

- Requires desktop Obsidian (community plugins are not supported on iOS/Android)
- Barcode scanning requires a USB or Bluetooth barcode scanner that acts as a keyboard input device
- Cover art is only available when a Discogs token is configured; MusicBrainz does not provide cover images
- Search result depth for common titles (e.g. popular operas) is capped at 30 results across all queries; use artist/conductor/label fields to narrow results
- Requires Obsidian v1.8.0 or later for Bases support

## Support

For bug reports and feature requests, please use the [GitHub Issues page](https://github.com/jimparrillo/obsidian-music-catalog/issues).
