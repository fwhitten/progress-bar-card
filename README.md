# Progress Bar Card

[![hacs][hacs-badge]][hacs-url]
[![release][release-badge]][release-url]

A progress bar card for Home Assistant. Point it at any numeric entity and it draws a single-row
bar with the icon, name and value laid over the fill — with the content automatically flipping
between light and dark ink as the bar passes underneath it.

Built for the **sections** dashboard layout: one grid row tall by default, resizable up to three.

## Features

- Works with any numeric entity, or a numeric **attribute** of any entity
- Works with **calendar entities** too: progress through the current event, with a live countdown
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

## Calendar entities

Point the card at a `calendar.` entity and it switches modes automatically.

- While an event is running, the bar tracks progress from its start to its end, and the secondary
  line counts down the time remaining.
- With nothing running, the bar sits empty and the secondary line counts down to the **next**
  event's start (`in 2h 15m`).
- When several events are running **at the same time**, the card crossfades between them.
- The name is the event title (auto-scrolling if long) and the value is percent elapsed. Your
  `name` and `icon` overrides still win if you set them.
- With no upcoming events the card dims and shows "No upcoming events".

```yaml
type: custom:ha-progress-card
entity: calendar.work
bar_color: blue
cycle_interval: 6
look_ahead_days: 7
include_all_day: true
```

Countdowns show the two most significant units, with seconds only once under an hour:
`3d 4h`, `2h 15m`, `4m 20s`, `45s`.

### How it gets the events

A calendar entity only ever exposes **one** event in its attributes, so the card calls the
`calendar.get_events` action to see everything in the look-ahead window — that is what makes
cycling between concurrent events possible. Responses are cached for five minutes and **shared
between cards**, so three cards on the same calendar make one request, not three. The card also
refetches whenever the entity's state changes. If `get_events` is unavailable, it falls back to
the single event in the entity's attributes.

The card runs its own clock so the bar and countdown advance between state updates: once a second
when the next boundary is under an hour away, once a minute otherwise, and **not at all** while
the card is off-screen or the browser tab is hidden.

Note that all-day events span local midnight to local midnight, so an all-day event shows as
progress through the day. Turn `include_all_day` off to ignore them.

## Installation

### HACS (recommended)

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.][my-hacs-badge]][my-hacs-url]

Click the button above to open this repository directly in HACS, then choose **Download**. It
works whether or not you have added the repository already.

<details>
<summary>Adding it by hand instead</summary>

1. In Home Assistant go to **HACS → ⋮ → Custom repositories**.
2. Add `https://github.com/fwhitten/progress-bar-card` with category **Dashboard**.
3. Find **Progress Bar Card** in the list and install it.
4. Reload your browser.

</details>

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

### Calendar-only options

These appear in the editor only when the entity is a calendar. `attribute`, `min`, `max` and
`value_mode` do not apply to calendars and are hidden.

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `cycle_interval` | number | `6` | Seconds each event is shown before crossfading to the next concurrent one |
| `look_ahead_days` | number | `7` | How far ahead to search for events |
| `include_all_day` | boolean | `true` | Include all-day events |
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

The bundle is written to `dist/ha-progress-card.js`, which is what HACS installs.

To cut a release, attach the bundle **when creating it** rather than letting CI add it afterwards:

```bash
npm run build && gh release create vX.Y.Z dist/ha-progress-card.js --title vX.Y.Z --notes "..."
```

A release that exists without its asset, even briefly, reads as a non-compliant repository to
HACS. The release workflow runs on the tag and re-uploads the CI-built bundle over the top, so
pushing a bare tag also produces a complete release.

## Licence

MIT

[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg
[hacs-url]: https://github.com/hacs/integration
[my-hacs-badge]: https://my.home-assistant.io/badges/hacs_repository.svg
[my-hacs-url]: https://my.home-assistant.io/redirect/hacs_repository/?owner=fwhitten&repository=progress-bar-card&category=plugin
[release-badge]: https://img.shields.io/github/v/release/fwhitten/progress-bar-card
[release-url]: https://github.com/fwhitten/progress-bar-card/releases/latest
