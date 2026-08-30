# Progress Bar Card

[![hacs][hacs-badge]][hacs-url]
[![release][release-badge]][release-url]

A progress bar card for Home Assistant. Point it at any numeric entity and it draws a single-row
bar with the icon, name and value laid over the fill — with the content automatically flipping
between light and dark ink as the bar passes underneath it.

Built for the **sections** dashboard layout: one grid row tall by default, resizable up to three.

## Features

- Works with any numeric entity, or a numeric **attribute** of any entity
- Fully configurable from the **visual editor** — no YAML required
- Configurable range (defaults to `0`–`100`)
- Value shown on the right as a whole-number percentage or the entity's own formatted value
- Name and secondary line **auto-scroll** when they don't fit
- Up to two extra entity states on a second line, dot separated
- Optional **colour thresholds** — the bar recolours as the value moves
- Icon and text contrast is computed from the bar colour so it stays readable either way
- Theme card background, theme corner radius or fully rounded
- Animated fill, light and dark mode, `prefers-reduced-motion` aware
- Standard tap / hold / double-tap actions

## Installation

### HACS (recommended)

1. In Home Assistant go to **HACS → ⋮ → Custom repositories**.
2. Add `https://github.com/fwhitten/progress-bar-card` with category **Dashboard**.
3. Find **Progress Bar Card** in the list and install it.
4. Reload your browser.

### Manual

1. Download `ha-progress-card.js` from the [latest release][release-url].
2. Copy it into `<config>/www/community/progress-bar-card/`.
3. Add the resource under **Settings → Dashboards → ⋮ → Resources**:
   - URL `/local/community/progress-bar-card/ha-progress-card.js`
   - Type **JavaScript module**

## Usage

Add the card from the dashboard card picker ("Progress Bar Card") and configure it visually, or
write it by hand:

```yaml
type: custom:ha-progress-card
entity: sensor.dishwasher_progress
name: Dishwasher
icon: mdi:dishwasher
secondary_entities:
  - sensor.dishwasher_time_remaining
bar_color: blue
thresholds:
  - value: 0
    color: red
  - value: 25
    color: blue
  - value: 100
    color: green
```

## Options

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | string | **required** | `custom:ha-progress-card` |
| `entity` | string | **required** | Any entity with a numeric state |
| `attribute` | string | — | Read this numeric attribute instead of the state |
| `name` | string | entity's friendly name | Overrides the displayed name |
| `icon` | string | entity's icon | Overrides the displayed icon |
| `min` | number | `0` | Value that renders as an empty bar |
| `max` | number | `100` | Value that renders as a full bar |
| `show_value` | boolean | `true` | Show the value on the right |
| `value_mode` | string | `auto` | `auto`, `percentage` or `value` |
| `shape` | string | `rounded` | `rounded` (pill) or `theme` (theme corner radius) |
| `bar_color` | string | `primary` | Bar colour when no threshold applies |
| `thresholds` | list | — | List of `{ value, color }` stops |
| `secondary_entities` | list | — | Up to two entities shown dot-separated under the name |
| `tap_action` | action | `more-info` | Standard Home Assistant action |
| `hold_action` | action | `none` | Standard Home Assistant action |
| `double_tap_action` | action | `none` | Standard Home Assistant action |

### `value_mode`

- `percentage` — the value's position within `min`–`max`, rounded to a whole number, e.g. `50%`
- `value` — the entity's own value formatted by Home Assistant, e.g. `21.5 °C`
- `auto` — percentage when the entity has no unit or its unit is `%`, otherwise the entity value

### Colours

Colours accept a Home Assistant theme colour name (`red`, `blue`, `green`, `amber`, `primary`,
`accent`, …), which is what the visual editor's colour picker produces, or any raw CSS colour
if you'd rather write YAML:

```yaml
bar_color: "#7e57c2"
```

### Thresholds

The bar takes the colour of the **highest threshold the value has reached**. Below every
threshold it falls back to `bar_color`.

```yaml
thresholds:
  - value: 0
    color: red
  - value: 20
    color: amber
  - value: 60
    color: green
```

With a battery sensor at 45% that bar is amber; at 70% it's green.

### Sizing

In a sections dashboard the card occupies one grid row by default. Drag its resize handle to make
it up to three rows tall — the icon and type scale up with the extra height. In a masonry
dashboard it renders at its natural single-row height.

## Contrast

The icon and text are drawn twice: once against the card background using the theme's own text
colours, and once inside a box clipped to the bar, coloured black or white depending on the bar's
measured luminance. The clip tracks the fill edge, so a glyph sitting on the boundary is rendered
half in each colour. The black/white choice uses the WCAG luminance crossover (`0.179`), which is
the point at which black and white score an equal contrast ratio against the background.

## Development

```bash
npm install
npm run build
```

The bundle is written to `dist/ha-progress-card.js`. Releases are built by GitHub Actions and the
bundle is attached to the release, which is what HACS installs.

## Licence

MIT

[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg
[hacs-url]: https://github.com/hacs/integration
[release-badge]: https://img.shields.io/github/v/release/fwhitten/progress-bar-card
[release-url]: https://github.com/fwhitten/progress-bar-card/releases/latest
