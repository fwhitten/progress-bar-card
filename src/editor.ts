import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { EDITOR_NAME } from "./const";
import type { HomeAssistant, LovelaceCardEditor, ProgressCardConfig, ThresholdConfig } from "./types";
import { fireEvent } from "./utils";

const LABELS: Record<string, string> = {
  entity: "Entity",
  attribute: "Attribute (optional)",
  name: "Name",
  icon: "Icon",
  min: "Minimum",
  max: "Maximum",
  shape: "Corner style",
  value_mode: "Value display",
  show_value: "Show value",
  bar_color: "Bar colour",
  secondary_entities: "Secondary entities (max 2)",
  pin_entity: "Pin when this entity...",
  pin_states: "...is in one of these states",
  pin_value: "Pin the bar to",
  include_all_day: "Include all-day events",
  cycle_interval: "Seconds between events",
  look_ahead_days: "Look ahead (days)",
  tap_action: "Tap action",
  hold_action: "Hold action",
  double_tap_action: "Double tap action",
};

const SHAPE_SELECTOR = {
  select: {
    mode: "dropdown",
    options: [
      { value: "rounded", label: "Fully rounded" },
      { value: "theme", label: "Theme radius" },
    ],
  },
};

const CALENDAR_SCHEMA = [
  {
    name: "",
    type: "grid",
    schema: [
      { name: "shape", selector: SHAPE_SELECTOR },
      {
        name: "cycle_interval",
        selector: { number: { mode: "box", min: 1, max: 120, step: 1, unit_of_measurement: "s" } },
      },
    ],
  },
  {
    name: "",
    type: "grid",
    schema: [
      {
        name: "look_ahead_days",
        selector: { number: { mode: "box", min: 1, max: 60, step: 1 } },
      },
      { name: "include_all_day", selector: { boolean: {} } },
    ],
  },
];

const SCHEMA = [
  { name: "entity", required: true, selector: { entity: {} } },
  {
    name: "attribute",
    selector: { attribute: {} },
    context: { filter_entity: "entity" },
  },
  {
    name: "",
    type: "grid",
    schema: [
      { name: "name", selector: { text: {} } },
      { name: "icon", selector: { icon: {} }, context: { icon_entity: "entity" } },
    ],
  },
  {
    name: "",
    type: "grid",
    schema: [
      { name: "min", selector: { number: { mode: "box", step: "any" } } },
      { name: "max", selector: { number: { mode: "box", step: "any" } } },
    ],
  },
  {
    name: "",
    type: "grid",
    schema: [
      {
        name: "value_mode",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "auto", label: "Automatic" },
              { value: "percentage", label: "Percentage of range" },
              { value: "value", label: "Entity value" },
            ],
          },
        },
      },
      { name: "shape", selector: SHAPE_SELECTOR },
    ],
  },
  {
    name: "pin",
    type: "expandable",
    flatten: true,
    icon: "mdi:pin",
    title: "Pin value on state",
    schema: [
      { name: "pin_entity", selector: { entity: {} } },
      {
        name: "pin_states",
        selector: { state: { multiple: true } },
        context: { filter_entity: "pin_entity" },
      },
      {
        name: "pin_value",
        selector: {
          select: {
            mode: "dropdown",
            custom_value: true,
            options: [
              { value: "max", label: "Maximum" },
              { value: "min", label: "Minimum" },
            ],
          },
        },
      },
    ],
  },
];

const TAIL_SCHEMA = [
  { name: "show_value", selector: { boolean: {} } },
  { name: "bar_color", selector: { ui_color: { default_color: "primary" } } },
  { name: "secondary_entities", selector: { entity: { multiple: true } } },
  {
    name: "interactions",
    type: "expandable",
    flatten: true,
    icon: "mdi:gesture-tap",
    title: "Interactions",
    schema: [
      { name: "tap_action", selector: { ui_action: { default_action: "more-info" } } },
      { name: "hold_action", selector: { ui_action: { default_action: "none" } } },
      { name: "double_tap_action", selector: { ui_action: { default_action: "none" } } },
    ],
  },
];

/**
 * ha-form's grid sizes its columns with repeat(auto-fit, minmax(200px, 1fr)),
 * which collapses to a single column when the form is not laid out at a
 * definite width. Pinning the column count and dropping the minimum keeps the
 * two fields side by side, and lets ha-form align them the way it does
 * everywhere else in Home Assistant.
 */
const THRESHOLD_SCHEMA = [
  {
    name: "",
    type: "grid",
    column_min_width: "0px",
    schema: [
      { name: "value", required: true, selector: { number: { mode: "box", step: "any" } } },
      { name: "color", selector: { ui_color: { default_color: "primary" } } },
    ],
  },
];

@customElement(EDITOR_NAME)
export class HaProgressCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() private _config?: ProgressCardConfig;

  public setConfig(config: ProgressCardConfig): void {
    this._config = config;
  }

  private get _thresholds(): ThresholdConfig[] {
    return this._config?.thresholds ?? [];
  }

  /**
   * Calendar entities drive the bar from event timings, so the range and value
   * options are meaningless for them and the cycling options take their place.
   */
  private get _schema() {
    const isCalendar = Boolean(this._config?.entity?.startsWith("calendar."));
    const head = isCalendar
      ? SCHEMA.filter(
          (item) => !["attribute", "pin"].includes(item.name) && !this._isRangeGrid(item),
        )
      : SCHEMA;
    return [...head, ...(isCalendar ? CALENDAR_SCHEMA : []), ...TAIL_SCHEMA];
  }

  private _isRangeGrid(item: { type?: string; schema?: { name: string }[] }): boolean {
    if (item.type !== "grid" || !item.schema) return false;
    return item.schema.some((field) => ["min", "max", "value_mode"].includes(field.name));
  }

  protected override render(): TemplateResult | typeof nothing {
    if (!this._config || !this.hass) return nothing;

    // ha-form owns everything except the threshold list, which is repeatable.
    const { thresholds: _thresholds, ...formData } = this._config;

    return html`
      <div class="editor">
        <ha-form
          .hass=${this.hass}
          .data=${formData}
          .schema=${this._schema}
          .computeLabel=${this._computeLabel}
          @value-changed=${this._formChanged}
        ></ha-form>

        <ha-expansion-panel outlined>
          <div slot="header" class="panel-header">
            <ha-icon icon="mdi:palette-swatch"></ha-icon>
            <span>Colour thresholds</span>
          </div>
          <div class="panel-body">
            <p class="hint">
              The bar takes the colour of the highest threshold the value has reached. Below every
              threshold it falls back to the bar colour above.
            </p>
            ${this._thresholds.map(
              (threshold, index) => html`
                <div class="threshold">
                  <ha-form
                    .hass=${this.hass}
                    .data=${threshold}
                    .schema=${THRESHOLD_SCHEMA}
                    .computeLabel=${this._computeThresholdLabel}
                    .index=${index}
                    @value-changed=${this._thresholdChanged}
                  ></ha-form>
                  <ha-icon-button
                    .label=${"Remove threshold"}
                    .index=${index}
                    @click=${this._removeThreshold}
                  >
                    <ha-icon icon="mdi:close"></ha-icon>
                  </ha-icon-button>
                </div>
              `,
            )}
            <ha-button @click=${this._addThreshold}>
              <ha-icon icon="mdi:plus" slot="icon"></ha-icon>
              Add threshold
            </ha-button>
          </div>
        </ha-expansion-panel>
      </div>
    `;
  }

  private _computeLabel = (schema: { name: string }): string =>
    LABELS[schema.name] ?? schema.name;

  private _computeThresholdLabel = (schema: { name: string }): string =>
    schema.name === "value" ? "At value" : "Colour";

  private _formChanged(ev: CustomEvent): void {
    ev.stopPropagation();
    if (!this._config) return;
    const updated = { ...this._config, ...(ev.detail.value as ProgressCardConfig) };
    this._emit(updated);
  }

  private _thresholdChanged(ev: CustomEvent): void {
    ev.stopPropagation();
    const index = (ev.currentTarget as HTMLElement & { index: number }).index;
    const thresholds = [...this._thresholds];
    thresholds[index] = { ...thresholds[index], ...(ev.detail.value as ThresholdConfig) };
    this._emit({ ...this._config!, thresholds });
  }

  private _removeThreshold(ev: Event): void {
    const index = (ev.currentTarget as HTMLElement & { index: number }).index;
    const thresholds = this._thresholds.filter((_, i) => i !== index);
    const config = { ...this._config! };
    if (thresholds.length) {
      config.thresholds = thresholds;
    } else {
      delete config.thresholds;
    }
    this._emit(config);
  }

  private _addThreshold(): void {
    const thresholds = [...this._thresholds];
    const last = thresholds[thresholds.length - 1];
    thresholds.push({ value: last ? last.value + 25 : 0, color: "blue" });
    this._emit({ ...this._config!, thresholds });
  }

  /** Strip the empty values ha-form hands back for cleared optional fields. */
  private _emit(config: ProgressCardConfig): void {
    const cleaned = { ...config };
    (Object.keys(cleaned) as (keyof ProgressCardConfig)[]).forEach((key) => {
      const value = cleaned[key];
      if (value === "" || value === undefined || value === null) {
        delete cleaned[key];
      }
      if (Array.isArray(value) && value.length === 0) {
        delete cleaned[key];
      }
    });
    if (Array.isArray(cleaned.secondary_entities)) {
      cleaned.secondary_entities = cleaned.secondary_entities.slice(0, 2);
    }
    this._config = cleaned;
    fireEvent(this, "config-changed", { config: cleaned });
  }

  static override get styles() {
    return css`
      .editor {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .panel-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 500;
      }

      .panel-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 0 8px 8px;
      }

      .hint {
        margin: 0 0 4px;
        color: var(--secondary-text-color);
        font-size: 12px;
      }

      .threshold {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
      }

      .threshold ha-form {
        --form-grid-column-count: 2;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-progress-card-editor": HaProgressCardEditor;
  }
}
