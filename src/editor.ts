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
  tap_action: "Tap action",
  hold_action: "Hold action",
  double_tap_action: "Double tap action",
};

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
      {
        name: "shape",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "rounded", label: "Fully rounded" },
              { value: "theme", label: "Theme radius" },
            ],
          },
        },
      },
    ],
  },
  { name: "show_value", selector: { boolean: {} } },
  { name: "bar_color", selector: { ui_color: { default_color: "primary" } } },
  { name: "secondary_entities", selector: { entity: { multiple: true } } },
  {
    name: "interactions",
    type: "expandable",
    iconPath: undefined,
    icon: "mdi:gesture-tap",
    title: "Interactions",
    schema: [
      { name: "tap_action", selector: { ui_action: { default_action: "more-info" } } },
      { name: "hold_action", selector: { ui_action: { default_action: "none" } } },
      { name: "double_tap_action", selector: { ui_action: { default_action: "none" } } },
    ],
  },
];

// Laid out by this editor rather than ha-form's grid, whose auto-fit columns
// collapse to one at the widths a card editor actually gets.
const THRESHOLD_VALUE_SCHEMA = [
  { name: "value", required: true, selector: { number: { mode: "box", step: "any" } } },
];

const THRESHOLD_COLOR_SCHEMA = [
  { name: "color", selector: { ui_color: { default_color: "primary" } } },
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

  protected override render(): TemplateResult | typeof nothing {
    if (!this._config || !this.hass) return nothing;

    // ha-form owns everything except the threshold list, which is repeatable.
    const { thresholds: _thresholds, ...formData } = this._config;

    return html`
      <div class="editor">
        <ha-form
          .hass=${this.hass}
          .data=${formData}
          .schema=${SCHEMA}
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
                    .schema=${THRESHOLD_VALUE_SCHEMA}
                    .computeLabel=${this._computeThresholdLabel}
                    .index=${index}
                    @value-changed=${this._thresholdChanged}
                  ></ha-form>
                  <ha-form
                    .hass=${this.hass}
                    .data=${threshold}
                    .schema=${THRESHOLD_COLOR_SCHEMA}
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
        grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) auto;
        align-items: center;
        gap: 8px;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-progress-card-editor": HaProgressCardEditor;
  }
}
